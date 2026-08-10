import { describe, expect, test } from "bun:test";
import { type CrawlOptions, isActiveCrawlStatus } from "../../../shared/contracts/index.js";
import { persistPageFixture } from "../../__tests__/pageFixture.js";
import {
	htmlDocumentResponse,
	htmlResponse,
	silentLogger,
	successfulHtmlHttpClient,
	waitFor,
} from "../../__tests__/runtimeFixture.js";
import { createInMemoryStorage } from "../../__tests__/storageFixture.js";
import { createApp } from "../../app.js";
import { CRAWL_QUEUE_CONSTANTS } from "../../constants.js";
import type { HttpClient } from "../../outbound/HttpClient.js";
import { CrawlManager } from "../../runtime/CrawlManager.js";
import { EventStream } from "../../runtime/EventStream.js";

function decodeSseChunk(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	throw new Error("Expected an SSE string or byte chunk");
}

function buildApp(
	httpClient: HttpClient = successfulHtmlHttpClient,
	storage = createInMemoryStorage(),
) {
	const eventStream = new EventStream();
	const logger = silentLogger;
	const crawlManager = new CrawlManager({
		logger,
		repos: storage.repos,
		eventStream,
		httpClient,
		storageBudget: storage.budget,
	});

	const app = createApp({
		logger,
		storage,
		eventStream,
		crawlManager,
		rateLimitGenerator: () => "api-contract-client",
	});

	return { app, crawlManager, storage };
}

const crawlBody: CrawlOptions = {
	target: "https://example.com",
	crawlMethod: "links",
	crawlDepth: 2,
	crawlDelay: 200,
	maxPages: 2,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 1,
	retryLimit: 0,
	dynamic: false,
	respectRobots: false,
	contentOnly: false,
	saveMedia: false,
};

function createCrawlRequestBody(options: unknown = crawlBody, id = crypto.randomUUID()) {
	return { id, options };
}

describe("api contract", () => {
	test("allowed cross-origin responses do not grant browser credentials", async () => {
		const { app } = buildApp();
		const response = await app.handle(
			new Request("http://localhost/api/health", {
				headers: { origin: "http://localhost:5173" },
			}),
		);

		expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
		expect(response.headers.get("access-control-allow-credentials")).toBeNull();
	});

	test("app factory uses injected storage", async () => {
		const { app, storage } = buildApp();

		storage.repos.crawlRuns.createRun("injected-storage-crawl", {
			...crawlBody,
			target: "https://injected.example",
		});
		persistPageFixture(storage, {
			crawlId: "injected-storage-crawl",
			url: "https://injected.example/page",
			title: "Injected storage needle",
			content: "<main>Injected storage needle</main>",
			mainContent: "Injected storage needle",
		});

		const response = await app.handle(
			new Request("http://localhost/api/search?crawlId=injected-storage-crawl&q=injected"),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(
			expect.objectContaining({
				count: 1,
			}),
		);
	});

	test("rejects crawl methods and status filters outside the declared contract", async () => {
		const { app } = buildApp();

		const invalidCreateResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					createCrawlRequestBody({
						...crawlBody,
						crawlMethod: "archive",
					}),
				),
			}),
		);
		expect(invalidCreateResponse.status).toBe(422);

		const invalidListResponse = await app.handle(
			new Request("http://localhost/api/crawls?status=unknown"),
		);
		expect(invalidListResponse.status).toBe(422);
	});

	test("rejects fractional numeric query and path parameters at the API boundary", async () => {
		const { app } = buildApp();

		const crawlListResponse = await app.handle(
			new Request("http://localhost/api/crawls?limit=1.5"),
		);
		expect(crawlListResponse.status).toBe(422);

		const searchResponse = await app.handle(
			new Request("http://localhost/api/search?q=contract&limit=1.5"),
		);
		expect(searchResponse.status).toBe(422);

		const pageContentResponse = await app.handle(
			new Request("http://localhost/api/crawls/example/pages/1.5/content"),
		);
		expect(pageContentResponse.status).toBe(422);
	});

	test("Elysia owns bounded numeric SSE replay cursor validation", async () => {
		const { app } = buildApp();

		for (const value of ["not-a-sequence", "-1", "1.5", String(Number.MAX_SAFE_INTEGER + 1)]) {
			const response = await app.handle(
				new Request("http://localhost/api/crawls/example/events", {
					headers: { "last-event-id": value },
				}),
			);
			expect(response.status).toBe(422);
		}

		for (const value of ["01", String(Number.MAX_SAFE_INTEGER)]) {
			const response = await app.handle(
				new Request("http://localhost/api/crawls/example/events", {
					headers: { "last-event-id": value },
				}),
			);
			expect(response.status).toBe(404);
		}
	});

	test("settled SSE reconnects stop after the terminal event cursor", async () => {
		const { app, crawlManager } = buildApp();
		const crawlId = "settled-sse-reconnect";
		crawlManager.create(crawlId, { ...crawlBody, maxPages: 1 });
		const settled = await waitFor(
			() => crawlManager.get(crawlId),
			(crawl) => crawl?.status === "completed",
		);
		if (!settled) throw new Error("Expected completed crawl");

		const response = await app.handle(
			new Request(`http://localhost/api/crawls/${crawlId}/events`, {
				headers: { "last-event-id": String(settled.eventSequence) },
			}),
		);

		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
	});

	test("rate limits failed SSE handshakes and ordinary query-string lookalikes", async () => {
		const { app } = buildApp();

		let response = new Response();
		for (let index = 0; index < 101; index += 1) {
			response = await app.handle(
				new Request(`http://localhost/api/crawls/missing/events?n=${index}`),
			);
		}
		expect(response.status).toBe(429);

		const { app: queryApp } = buildApp();
		for (let index = 0; index < 101; index += 1) {
			response = await queryApp.handle(
				new Request(`http://localhost/api/search?crawlId=missing&q=/events&n=${index}`),
			);
		}

		expect(response.status).toBe(429);
	});

	test("rate limits schema-invalid request bodies before route parsing", async () => {
		const { app } = buildApp();

		let response = new Response();
		for (let index = 0; index < 101; index += 1) {
			response = await app.handle(
				new Request("http://localhost/api/crawls", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ invalid: index }),
				}),
			);
		}

		expect(response.status).toBe(429);
	});

	test("rejects non-integer crawl option fields", async () => {
		const { app } = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					createCrawlRequestBody({
						...crawlBody,
						crawlDepth: 1.5,
						crawlDelay: 200.2,
						maxPages: 1.1,
						maxPagesPerDomain: 0.5,
						maxConcurrentRequests: 1.5,
						retryLimit: 0.5,
					}),
				),
			}),
		);

		expect(response.status).toBe(422);
	});

	test("rejects invalid crawl targets at create time", async () => {
		const { app, storage } = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					createCrawlRequestBody({
						...crawlBody,
						target: "mailto:test@example.com",
					}),
				),
			}),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "Only HTTP and HTTPS URLs are supported",
			code: "INVALID_TARGET",
		});
		expect(storage.repos.crawlRuns.list()).toHaveLength(0);
	});

	test("normalizes accepted crawl targets before persisting the crawl", async () => {
		const { app } = buildApp();

		const response = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					createCrawlRequestBody({
						...crawlBody,
						target: "example.com/path?b=2&a=1#fragment",
					}),
				),
			}),
		);

		expect(response.status).toBe(200);
		const created = await response.json();
		expect(created.target).toBe("http://example.com/path?b=2&a=1");
		expect(created.options.target).toBe("http://example.com/path?b=2&a=1");
	});

	test("rejects create admission after shutdown begins", async () => {
		const { app, crawlManager, storage } = buildApp();
		const paused = storage.repos.crawlRuns.createRun("shutdown-resume", {
			...crawlBody,
			target: "https://shutdown-resume.example",
		});
		storage.repos.crawlRuns.markPaused(paused.id, "Paused", 0);
		const shutdown = crawlManager.shutdownAll();
		const createResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createCrawlRequestBody()),
			}),
		);
		const resumeResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${paused.id}/resume`, {
				method: "POST",
			}),
		);
		await shutdown;

		expect(createResponse.status).toBe(503);
		expect(await createResponse.json()).toEqual({
			error: "Crawl service is shutting down",
			code: "SERVICE_CLOSING",
		});
		expect(resumeResponse.status).toBe(503);
		expect(await resumeResponse.json()).toEqual({
			error: "Crawl service is shutting down",
			code: "SERVICE_CLOSING",
		});
		expect(storage.repos.crawlRuns.getById(paused.id)?.status).toBe("paused");
		expect(crawlManager.activeRuntimeCount).toBe(0);
	});

	test("rejects crawl admission before the durable capacity safety reservation is exhausted", async () => {
		const storage = createInMemoryStorage({ maxBytes: 8 * 1024 * 1024 });
		const { app } = buildApp(
			{
				fetch: async () => new Response("unused"),
			},
			storage,
		);
		const crawlId = crypto.randomUUID();
		const response = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createCrawlRequestBody(crawlBody, crawlId)),
			}),
		);

		expect(response.status).toBe(507);
		expect(await response.json()).toEqual(
			expect.objectContaining({ code: "STORAGE_CAPACITY_EXHAUSTED" }),
		);
		expect(storage.repos.crawlRuns.getById(crawlId)).toBeNull();
	});

	test("projects active runtime exhaustion as an explicit service-capacity response", async () => {
		const { app, crawlManager, storage } = buildApp({
			fetch: ({ signal }) =>
				new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
						once: true,
					});
				}),
		});
		for (let index = 0; index < CRAWL_QUEUE_CONSTANTS.MAX_ACTIVE_RUNTIMES; index += 1) {
			const response = await app.handle(
				new Request("http://localhost/api/crawls", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(
						createCrawlRequestBody({
							...crawlBody,
							target: `https://capacity-${index}.example`,
						}),
					),
				}),
			);
			expect(response.status).toBe(200);
		}
		const rejectedId = crypto.randomUUID();
		const rejected = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					createCrawlRequestBody(
						{ ...crawlBody, target: "https://capacity-rejected.example" },
						rejectedId,
					),
				),
			}),
		);

		expect(rejected.status).toBe(503);
		expect(await rejected.json()).toEqual({
			error: `Active crawl capacity reached (${CRAWL_QUEUE_CONSTANTS.MAX_ACTIVE_RUNTIMES})`,
			code: "RUNTIME_CAPACITY_REACHED",
		});
		expect(storage.repos.crawlRuns.getById(rejectedId)).toBeNull();
		await crawlManager.shutdownAll();
	});

	test("create acknowledges a persisted active crawl before fetch completion", async () => {
		let releaseFetch!: () => void;
		const { app, storage } = buildApp({
			fetch: () =>
				new Promise<Response>((resolve) => {
					releaseFetch = () => resolve(htmlResponse("held"));
				}),
		});

		const response = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createCrawlRequestBody()),
			}),
		);

		expect(response.status).toBe(200);
		const created = await response.json();
		const persisted = storage.repos.crawlRuns.getById(created.id);
		expect(isActiveCrawlStatus(created.status)).toBe(true);
		expect(persisted?.id).toBe(created.id);
		expect(persisted && isActiveCrawlStatus(persisted.status)).toBe(true);
		expect(created.status).not.toBe("pending");
		await waitFor(
			() => typeof releaseFetch,
			(value) => value === "function",
		);
		releaseFetch();
		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);
	});

	test("create crawl, get crawl, list crawl, page content, and search", async () => {
		const html =
			"<html><body><main>Hello api contract</main><title>API Contract</title></body></html>";
		const { app, storage } = buildApp({
			fetch: async () => htmlDocumentResponse(html),
		});

		const createResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createCrawlRequestBody()),
			}),
		);
		expect(createResponse.status).toBe(200);
		const created = await createResponse.json();

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		const getResponse = await app.handle(new Request(`http://localhost/api/crawls/${created.id}`));
		expect(getResponse.status).toBe(200);

		const listResponse = await app.handle(
			new Request("http://localhost/api/crawls?status=completed"),
		);
		const listed = await listResponse.json();
		expect(listed.crawls).toHaveLength(1);

		const pages = Array.from(storage.repos.pages.iterateForExport(created.id));
		const pageSnapshotResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${created.id}/pages`),
		);
		expect(pageSnapshotResponse.status).toBe(200);
		expect(await pageSnapshotResponse.json()).toEqual({
			count: 1,
			pages: [
				expect.objectContaining({
					id: pages[0].id,
					url: pages[0].url,
				}),
			],
		});
		const recoverySnapshotResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${created.id}/snapshot`),
		);
		expect(recoverySnapshotResponse.status).toBe(200);
		expect(await recoverySnapshotResponse.json()).toEqual({
			crawl: expect.objectContaining({
				id: created.id,
				status: "completed",
			}),
			pageCount: 1,
			pages: [
				expect.objectContaining({
					id: pages[0].id,
					url: pages[0].url,
				}),
			],
		});
		const pageContentResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${created.id}/pages/${pages[0].id}/content`),
		);
		expect(pageContentResponse.status).toBe(200);
		const pageContent = await pageContentResponse.json();
		expect(pageContent.content).toContain("Hello api contract");

		const searchResponse = await app.handle(
			new Request(`http://localhost/api/search?crawlId=${created.id}&q=contract`),
		);
		expect(searchResponse.status).toBe(200);
		const search = await searchResponse.json();
		expect(search.count).toBeGreaterThan(0);
	});

	test("page content response preserves null and empty body semantics", async () => {
		const { app, storage } = buildApp();
		const crawl = storage.repos.crawlRuns.createRun("crawl-page-content-contract", crawlBody);
		const basePage = { crawlId: crawl.id };
		const emptyId = persistPageFixture(storage, {
			...basePage,
			url: "https://example.com/empty",
			content: "",
		});
		const nullId = persistPageFixture(storage, {
			...basePage,
			url: "https://example.com/metadata-only",
			content: null,
		});

		const emptyResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${crawl.id}/pages/${emptyId}/content`),
		);
		const nullResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${crawl.id}/pages/${nullId}/content`),
		);

		expect(await emptyResponse.json()).toMatchObject({ content: "" });
		expect(await nullResponse.json()).toMatchObject({ content: null });
	});

	test("page content cannot be read through another crawl identity", async () => {
		const { app, storage } = buildApp();
		const owner = storage.repos.crawlRuns.createRun("page-owner", crawlBody);
		const other = storage.repos.crawlRuns.createRun("other-crawl", {
			...crawlBody,
			target: "https://other.example/",
		});
		const pageId = persistPageFixture(storage, {
			crawlId: owner.id,
			url: "https://example.com/private",
			content: "owner-only",
		});

		const response = await app.handle(
			new Request(`http://localhost/api/crawls/${other.id}/pages/${pageId}/content`),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Page not found for crawl" });
	});

	test("export includes stored content and search count reports total matches", async () => {
		const { app, storage } = buildApp();
		const crawl = storage.repos.crawlRuns.createRun("crawl-search-export", crawlBody);

		for (const index of [1, 2, 3]) {
			persistPageFixture(storage, {
				crawlId: crawl.id,
				url: `https://example.com/page-${index}`,
				title: `Needle page ${index}`,
				description: "Search count contract",
				content: `<main>needle export body ${index}</main>`,
				mainContent: `needle export body ${index}`,
			});
		}

		const exportResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${crawl.id}/export`),
		);
		expect(exportResponse.status).toBe(200);
		const exported = await exportResponse.json();
		expect(exported[0].content).toContain("needle export body");

		const searchResponse = await app.handle(
			new Request(`http://localhost/api/search?crawlId=${crawl.id}&q=needle&limit=2`),
		);
		expect(searchResponse.status).toBe(200);
		const search = await searchResponse.json();
		expect(search.results).toHaveLength(2);
		expect(search.count).toBe(3);
	});

	test("openapi documents streaming and export media types truthfully", async () => {
		const { app } = buildApp();

		const response = await app.handle(new Request("http://localhost/openapi/json"));

		expect(response.status).toBe(200);
		const spec = await response.json();
		const lastEventIdParameter = spec.paths["/api/crawls/{id}/events"].get.parameters.find(
			(parameter: { name?: string }) => parameter.name === "Last-Event-ID",
		);
		const eventContent = spec.paths["/api/crawls/{id}/events"].get.responses["200"].content;
		const exportContent = spec.paths["/api/crawls/{id}/export"].get.responses["200"].content;
		const findParameter = (path: string, name: string) =>
			spec.paths[path].get.parameters.find(
				(parameter: { name?: string }) => parameter.name === name,
			);

		expect(lastEventIdParameter?.schema).toEqual({
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
		});
		expect(lastEventIdParameter?.description).toContain("Bounded live replay cursor");
		expect(findParameter("/api/crawls/", "limit")?.schema.default).toBe(25);
		expect(findParameter("/api/crawls/resumable", "limit")?.schema.default).toBe(25);
		expect(findParameter("/api/search", "limit")?.schema.default).toBe(20);
		expect(spec.tags.map(({ name }: { name: string }) => name)).not.toContain("Pages");
		expect(spec.paths["/api/crawls/{id}/pages/{pageId}/content"].get.tags).toEqual(["Crawls"]);
		expect(spec.paths["/api/crawls/{id}/events"].get.responses).toHaveProperty("204");
		expect(eventContent).toHaveProperty("text/event-stream");
		expect(eventContent).not.toHaveProperty("text/plain");

		const referencedSchemas = new Set<string>();
		const collectSchemaReferences = (value: unknown): void => {
			if (!value || typeof value !== "object") return;
			if ("$ref" in value && typeof value.$ref === "string") {
				referencedSchemas.add(value.$ref);
			}
			for (const nested of Object.values(value)) collectSchemaReferences(nested);
		};
		collectSchemaReferences(spec);
		for (const reference of referencedSchemas) {
			const componentName = reference.match(/^#\/components\/schemas\/(.+)$/)?.[1];
			if (componentName) expect(spec.components?.schemas).toHaveProperty(componentName);
		}

		const uiResponse = await app.handle(new Request("http://localhost/openapi"));
		expect(uiResponse.status).toBe(404);
		expect(exportContent["application/json"].schema.type).toBe("array");
		expect(exportContent).toHaveProperty("application/json");
		expect(exportContent).toHaveProperty("text/csv");
		expect(exportContent).not.toHaveProperty("text/plain");
	});

	test("caller-owned crawl identities make create retries idempotent", async () => {
		const { app, storage } = buildApp({
			fetch: async () => htmlResponse("idempotent"),
		});
		const crawlId = crypto.randomUUID();
		const requestBody = createCrawlRequestBody(crawlBody, crawlId);
		const createRequest = () =>
			app.handle(
				new Request("http://localhost/api/crawls", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(requestBody),
				}),
			);

		const first = await createRequest();
		const retry = await createRequest();
		expect(first.status).toBe(200);
		expect(retry.status).toBe(200);
		expect((await first.json()).id).toBe(crawlId);
		expect((await retry.json()).id).toBe(crawlId);
		expect(storage.repos.crawlRuns.list()).toHaveLength(1);

		const conflict = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					createCrawlRequestBody({ ...crawlBody, maxPages: crawlBody.maxPages + 1 }, crawlId),
				),
			}),
		);
		expect(conflict.status).toBe(409);
	});

	test("multi-term search matches pages containing all terms without requiring an exact phrase", async () => {
		const { app, storage } = buildApp();
		const crawl = storage.repos.crawlRuns.createRun("crawl-search-terms", crawlBody);

		for (const [slug, mainContent] of [
			["phrase", "alpha beta"],
			["separated", "alpha gamma beta"],
			["partial", "alpha only"],
		]) {
			persistPageFixture(storage, {
				crawlId: crawl.id,
				url: `https://example.com/${slug}`,
				title: slug,
				description: "Search term contract",
				content: `<main>${mainContent}</main>`,
				mainContent,
			});
		}

		const response = await app.handle(
			new Request(`http://localhost/api/search?crawlId=${crawl.id}&q=alpha%20beta`),
		);

		expect(response.status).toBe(200);
		const search = await response.json();
		expect(search.count).toBe(2);
		expect(search.results.map((result: { url: string }) => result.url).sort()).toEqual([
			"https://example.com/phrase",
			"https://example.com/separated",
		]);
	});

	test("search returns string snippets for content-only pages", async () => {
		const { app, storage } = buildApp();
		const crawl = storage.repos.crawlRuns.createRun("crawl-content-only-api-search", {
			...crawlBody,
			target: "https://content-only.example",
			contentOnly: true,
		});
		persistPageFixture(storage, {
			crawlId: crawl.id,
			url: "https://content-only.example/page",
			title: "Stored without source",
			content: null,
			mainContent: "uniquecontentonlyneedle body",
		});

		const response = await app.handle(
			new Request(`http://localhost/api/search?crawlId=${crawl.id}&q=uniquecontentonlyneedle`),
		);

		expect(response.status).toBe(200);
		const search = await response.json();
		expect(search.results[0].snippet).toContain("uniquecontentonlyneedle");
	});

	test("resume returns the backend-owned recovery snapshot before the new SSE generation", async () => {
		const { app, storage } = buildApp({
			fetch: async () => htmlResponse("resumed target"),
		});
		const crawl = storage.repos.crawlRuns.createRun("crawl-resume-snapshot", crawlBody);
		persistPageFixture(storage, {
			crawlId: crawl.id,
			url: "https://example.com/prior",
			title: "Prior durable page",
			description: "Stored before pause",
			content: "<main>prior</main>",
			mainContent: "prior",
		});
		storage.repos.crawlRuns.markPaused(crawl.id, "Paused", 7);

		const response = await app.handle(
			new Request(`http://localhost/api/crawls/${crawl.id}/resume`, { method: "POST" }),
		);
		expect(response.status).toBe(200);
		const resumed = await response.json();
		expect(resumed.crawl.id).toBe(crawl.id);
		expect(resumed.pageCount).toBe(1);
		expect(resumed.pages).toEqual([
			expect.objectContaining({
				url: "https://example.com/prior",
				title: "Prior durable page",
			}),
		]);
	});

	test("resume rejects terminal crawls", async () => {
		const { app, storage } = buildApp({
			fetch: async () => htmlResponse("done"),
		});

		const createResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createCrawlRequestBody()),
			}),
		);
		const created = await createResponse.json();

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		const resumeResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${created.id}/resume`, {
				method: "POST",
			}),
		);

		expect(resumeResponse.status).toBe(409);
	});

	test("stop returns the current snapshot for terminal crawls", async () => {
		const { app, storage } = buildApp({
			fetch: async () => htmlResponse("done"),
		});

		const createResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createCrawlRequestBody()),
			}),
		);
		const created = await createResponse.json();

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		const stopResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${created.id}/stop`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "pause" }),
			}),
		);

		expect(stopResponse.status).toBe(200);
		expect(await stopResponse.json()).toMatchObject({
			id: created.id,
			status: "completed",
		});
	});

	test("resume rejects an active runtime", async () => {
		const { app, crawlManager } = buildApp({
			fetch: ({ signal }) =>
				new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		});
		const crawlId = crypto.randomUUID();
		const createResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createCrawlRequestBody(crawlBody, crawlId)),
			}),
		);
		expect(createResponse.status).toBe(200);

		const response = await app.handle(
			new Request(`http://localhost/api/crawls/${crawlId}/resume`, { method: "POST" }),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "Crawl is already running" });
		await crawlManager.shutdownAll();
	});

	test("delete rejects persisted active crawl records without a live runtime", async () => {
		const { app, storage } = buildApp();

		const active = storage.repos.crawlRuns.createRun("orphan-running-crawl", {
			...crawlBody,
			target: "https://running.example",
		});
		storage.repos.crawlRuns.markRunning(active.id, 0);

		const deleteResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${active.id}`, {
				method: "DELETE",
			}),
		);

		expect(deleteResponse.status).toBe(409);
		expect(await deleteResponse.json()).toEqual({
			error: "Active crawls cannot be deleted",
		});
		expect(storage.repos.crawlRuns.getById(active.id)?.status).toBe("running");
	});

	test("delete retries report the already-absent outcome as success", async () => {
		const { app, storage } = buildApp();
		const paused = storage.repos.crawlRuns.createRun("delete-idempotent", {
			...crawlBody,
			target: "https://delete.example",
		});
		storage.repos.crawlRuns.markPaused(paused.id, "Paused", 0);

		const remove = () =>
			app.handle(
				new Request(`http://localhost/api/crawls/${paused.id}`, {
					method: "DELETE",
				}),
			);
		const first = await remove();
		const retry = await remove();

		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ status: "ok", outcome: "deleted" });
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual({ status: "ok", outcome: "already-absent" });
	});

	test("resumable crawl endpoint returns only paused and interrupted runs", async () => {
		const { app, storage } = buildApp();

		const paused = storage.repos.crawlRuns.createRun("paused-crawl", {
			...crawlBody,
			target: "https://paused.example",
		});
		const pausing = storage.repos.crawlRuns.createRun("pausing-crawl", {
			...crawlBody,
			target: "https://pausing.example",
		});
		const interrupted = storage.repos.crawlRuns.createRun("interrupted-crawl", {
			...crawlBody,
			target: "https://interrupted.example",
		});
		const completed = storage.repos.crawlRuns.createRun("completed-crawl", {
			...crawlBody,
			target: "https://completed.example",
		});
		storage.repos.crawlRuns.markPaused(paused.id, "Paused", 0);
		storage.repos.crawlRuns.markPausing(pausing.id, "Pause requested", 0);
		storage.repos.crawlRuns.markInterrupted(interrupted.id, "Shutdown", 0);
		storage.repos.crawlRuns.markCompleted(completed.id, null, 0);

		const response = await app.handle(new Request("http://localhost/api/crawls/resumable"));

		expect(response.status).toBe(200);
		const listed = await response.json();
		expect(listed.crawls.map((crawl: { id: string }) => crawl.id).sort()).toEqual([
			"interrupted-crawl",
			"paused-crawl",
		]);
	});

	test("sse delivers ordered events and disconnect does not stop the crawl", async () => {
		let releaseFetch!: () => void;
		const { app, storage } = buildApp({
			fetch: () =>
				new Promise<Response>((resolve) => {
					releaseFetch = () => resolve(htmlResponse("stream"));
				}),
		});

		const createResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createCrawlRequestBody({ ...crawlBody, maxPages: 1 })),
			}),
		);
		const created = await createResponse.json();

		const sseResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${created.id}/events`),
		);
		const reader = sseResponse.body?.getReader();
		expect(reader).toBeTruthy();
		expect(sseResponse.headers.get("cache-control")).toBe("no-cache, no-transform");
		expect(sseResponse.headers.get("x-accel-buffering")).toBe("no");
		if (!reader) {
			throw new Error("Expected SSE reader to be available");
		}

		releaseFetch();
		const firstChunk = await reader.read();
		const firstWireChunk = decodeSseChunk(firstChunk.value);
		expect(firstWireChunk).toContain("event: crawl.started");
		await reader.cancel();

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);
		expect(completed?.status).toBe("completed");
	});

	test("one client cannot occupy every SSE slot for a crawl", async () => {
		let releaseFetch!: () => void;
		const { app, storage } = buildApp({
			fetch: () =>
				new Promise<Response>((resolve) => {
					releaseFetch = () =>
						resolve(htmlDocumentResponse("<html><body><main>stream</main></body></html>"));
				}),
		});
		const createdResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createCrawlRequestBody({ ...crawlBody, maxPages: 1 })),
			}),
		);
		const created = await createdResponse.json();
		const url = `http://localhost/api/crawls/${created.id}/events`;
		const first = await app.handle(new Request(url));
		const second = await app.handle(new Request(url));
		const rejected = await app.handle(new Request(url));

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(rejected.status).toBe(429);
		expect(await rejected.json()).toEqual({
			error: "SSE subscriber capacity reached",
			code: "SSE_CAPACITY_REACHED",
		});

		await first.body?.cancel();
		await second.body?.cancel();
		releaseFetch();
		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(crawl) => crawl?.status === "completed",
		);
	});
});
