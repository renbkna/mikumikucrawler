import { describe, expect, mock, test } from "bun:test";
import type { CrawlOptions } from "../../../shared/contracts/index.js";
import { createApp } from "../../app.js";
import type { AppLogger } from "../../config/logging.js";
import type { HttpClient, Resolver } from "../../plugins/security.js";
import { CrawlManager } from "../../runtime/CrawlManager.js";
import type { CrawlRuntime } from "../../runtime/CrawlRuntime.js";
import { EventStream } from "../../runtime/EventStream.js";
import { RuntimeRegistry } from "../../runtime/RuntimeRegistry.js";
import { createInMemoryStorage } from "../../storage/db.js";

function createLogger(): AppLogger {
	return {
		level: "info",
		info: mock(() => undefined),
		warn: mock(() => undefined),
		error: mock(() => undefined),
		debug: mock(() => undefined),
		fatal: mock(() => undefined),
		trace: mock(() => undefined),
		silent: mock(() => undefined),
		child: mock(() => createLogger()),
		close: mock(() => undefined),
	} as unknown as AppLogger;
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean) {
	const timeoutAt = Date.now() + 5000;
	while (Date.now() < timeoutAt) {
		const value = read();
		if (predicate(value)) {
			return value;
		}
		await Bun.sleep(25);
	}

	throw new Error("Timed out waiting for condition");
}

function buildApp(httpClient: HttpClient) {
	const storage = createInMemoryStorage();
	const eventStream = new EventStream();
	const registry = new RuntimeRegistry();
	const logger = createLogger();
	const resolver: Resolver = {
		assertPublicHostname: async () => {},
		resolveHost: async () => ["93.184.216.34"],
	};
	const crawlManager = new CrawlManager({
		logger,
		repos: storage.repos,
		eventStream,
		registry,
		resolver,
		httpClient,
	});

	const app = createApp({
		logger,
		storage,
		resolver,
		httpClient,
		eventStream,
		runtimeRegistry: registry,
		crawlManager,
	});

	return { app, crawlManager, registry, storage };
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

describe("api contract", () => {
	test("app factory uses injected storage", async () => {
		const { app, storage } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		storage.repos.crawlRuns.createRun(
			"injected-storage-crawl",
			"https://injected.example",
			{ ...crawlBody, target: "https://injected.example" },
		);
		storage.repos.pages.save({
			crawlId: "injected-storage-crawl",
			url: "https://injected.example/page",
			domain: "injected.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 128,
			title: "Injected storage needle",
			description: "",
			content: "<main>Injected storage needle</main>",
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "Injected storage needle" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		});

		const response = await app.handle(
			new Request("http://localhost/api/search?q=injected"),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(
			expect.objectContaining({
				count: 1,
			}),
		);
	});

	test("rejects crawl methods and status filters outside the declared contract", async () => {
		const { app } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const invalidCreateResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...crawlBody,
					crawlMethod: "archive",
				}),
			}),
		);
		expect(invalidCreateResponse.status).toBe(422);

		const invalidListResponse = await app.handle(
			new Request("http://localhost/api/crawls?status=unknown"),
		);
		expect(invalidListResponse.status).toBe(422);
	});

	test("rejects fractional numeric query and path parameters at the API boundary", async () => {
		const { app } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const crawlListResponse = await app.handle(
			new Request("http://localhost/api/crawls?limit=1.5"),
		);
		expect(crawlListResponse.status).toBe(422);

		const searchResponse = await app.handle(
			new Request("http://localhost/api/search?q=contract&limit=1.5"),
		);
		expect(searchResponse.status).toBe(422);

		const pageContentResponse = await app.handle(
			new Request("http://localhost/api/pages/1.5/content"),
		);
		expect(pageContentResponse.status).toBe(422);
	});

	test("rejects malformed SSE replay headers at the API boundary", async () => {
		const { app } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const response = await app.handle(
			new Request("http://localhost/api/crawls/example/events", {
				headers: {
					"last-event-id": "not-a-sequence",
				},
			}),
		);

		expect(response.status).toBe(422);
	});

	test("rate-limit exemptions are exact route paths, not query-string substrings", async () => {
		const { app } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		let response = new Response();
		for (let index = 0; index < 101; index += 1) {
			response = await app.handle(
				new Request(`http://localhost/api/crawls/missing/events?n=${index}`),
			);
		}
		expect(response.status).toBe(404);

		for (let index = 0; index < 101; index += 1) {
			response = await app.handle(
				new Request(`http://localhost/api/search?q=/events&n=${index}`),
			);
		}

		expect(response.status).toBe(429);
	});

	test("rejects non-integer crawl option fields", async () => {
		const { app } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const response = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...crawlBody,
					crawlDepth: 1.5,
					crawlDelay: 200.2,
					maxPages: 1.1,
					maxPagesPerDomain: 0.5,
					maxConcurrentRequests: 1.5,
					retryLimit: 0.5,
				}),
			}),
		);

		expect(response.status).toBe(422);
	});

	test("rejects invalid crawl targets at create time", async () => {
		const { app, storage } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const response = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...crawlBody,
					target: "mailto:test@example.com",
				}),
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
		const { app } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const response = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...crawlBody,
					target: "example.com/path?b=2&a=1#fragment",
				}),
			}),
		);

		expect(response.status).toBe(200);
		const created = await response.json();
		expect(created.target).toBe("http://example.com/path?a=1&b=2");
		expect(created.options.target).toBe("http://example.com/path?a=1&b=2");
	});

	test("create response matches the persisted startup snapshot", async () => {
		let releaseFetch!: () => void;
		const { app, storage } = buildApp({
			fetch: () =>
				new Promise<Response>((resolve) => {
					releaseFetch = () =>
						resolve(
							new Response("<html><body><main>held</main></body></html>", {
								status: 200,
								headers: { "content-type": "text/html" },
							}),
						);
				}),
		});

		const response = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(crawlBody),
			}),
		);

		expect(response.status).toBe(200);
		const created = await response.json();
		const persisted = storage.repos.crawlRuns.getById(created.id);
		expect(created.status).toBe(persisted?.status);
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
			fetch: async () =>
				new Response(html, {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const createResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(crawlBody),
			}),
		);
		expect(createResponse.status).toBe(200);
		const created = await createResponse.json();

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		const getResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${created.id}`),
		);
		expect(getResponse.status).toBe(200);

		const listResponse = await app.handle(
			new Request("http://localhost/api/crawls?status=completed"),
		);
		const listed = await listResponse.json();
		expect(listed.crawls).toHaveLength(1);

		const pages = storage.repos.pages.listForExport(created.id);
		const pageContentResponse = await app.handle(
			new Request(`http://localhost/api/pages/${pages[0].id}/content`),
		);
		expect(pageContentResponse.status).toBe(200);
		const pageContent = await pageContentResponse.json();
		expect(pageContent.content).toContain("Hello api contract");

		const searchResponse = await app.handle(
			new Request("http://localhost/api/search?q=contract"),
		);
		expect(searchResponse.status).toBe(200);
		const search = await searchResponse.json();
		expect(search.count).toBeGreaterThan(0);
	});

	test("page content response preserves null and empty body semantics", async () => {
		const { app, storage } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});
		const crawl = storage.repos.crawlRuns.createRun(
			"crawl-page-content-contract",
			"https://example.com",
			crawlBody,
		);
		const basePage = {
			crawlId: crawl.id,
			domain: "example.com",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 0,
			title: "",
			description: "",
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		};
		const emptyId = storage.repos.pages.save({
			...basePage,
			url: "https://example.com/empty",
			content: "",
		});
		const nullId = storage.repos.pages.save({
			...basePage,
			url: "https://example.com/metadata-only",
			content: null,
		});

		const emptyResponse = await app.handle(
			new Request(`http://localhost/api/pages/${emptyId}/content`),
		);
		const nullResponse = await app.handle(
			new Request(`http://localhost/api/pages/${nullId}/content`),
		);

		expect(await emptyResponse.json()).toMatchObject({ content: "" });
		expect(await nullResponse.json()).toMatchObject({ content: null });
	});

	test("export includes stored content and search count reports total matches", async () => {
		const { app, storage } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});
		const crawl = storage.repos.crawlRuns.createRun(
			"crawl-search-export",
			"https://example.com",
			crawlBody,
		);

		for (const index of [1, 2, 3]) {
			storage.repos.pages.save({
				crawlId: crawl.id,
				url: `https://example.com/page-${index}`,
				domain: "example.com",
				contentType: "text/html",
				statusCode: 200,
				contentLength: 128,
				title: `Needle page ${index}`,
				description: "Search count contract",
				content: `<main>needle export body ${index}</main>`,
				isDynamic: false,
				lastModified: null,
				etag: null,
				processedContent: {
					extractedData: { mainContent: `needle export body ${index}` },
					metadata: {},
					analysis: {},
					media: [],
					links: [],
					errors: [],
				},
				links: [],
			});
		}

		const exportResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${crawl.id}/export`),
		);
		expect(exportResponse.status).toBe(200);
		const exported = await exportResponse.json();
		expect(exported[0].content).toContain("needle export body");

		const searchResponse = await app.handle(
			new Request("http://localhost/api/search?q=needle&limit=2"),
		);
		expect(searchResponse.status).toBe(200);
		const search = await searchResponse.json();
		expect(search.results).toHaveLength(2);
		expect(search.count).toBe(3);
	});

	test("openapi documents streaming and export media types truthfully", async () => {
		const { app } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const response = await app.handle(
			new Request("http://localhost/openapi/json"),
		);

		expect(response.status).toBe(200);
		const spec = await response.json();
		const lastEventIdParameter = spec.paths[
			"/api/crawls/{id}/events"
		].get.parameters.find(
			(parameter: { name?: string }) => parameter.name === "Last-Event-ID",
		);
		const eventContent =
			spec.paths["/api/crawls/{id}/events"].get.responses["200"].content;
		const exportContent =
			spec.paths["/api/crawls/{id}/export"].get.responses["200"].content;
		const findParameter = (path: string, name: string) =>
			spec.paths[path].get.parameters.find(
				(parameter: { name?: string }) => parameter.name === name,
			);

		expect(lastEventIdParameter?.schema).toEqual({
			type: "string",
			pattern: "^(0|[1-9]\\d*)$",
		});
		expect(findParameter("/api/crawls/", "limit")?.schema.default).toBe(25);
		expect(
			findParameter("/api/crawls/resumable", "limit")?.schema.default,
		).toBe(25);
		expect(findParameter("/api/search", "limit")?.schema.default).toBe(20);
		expect(eventContent).toHaveProperty("text/event-stream");
		expect(eventContent).not.toHaveProperty("text/plain");
		expect(exportContent["application/json"].schema.type).toBe("array");
		expect(exportContent).toHaveProperty("application/json");
		expect(exportContent).toHaveProperty("text/csv");
		expect(exportContent).not.toHaveProperty("text/plain");
	});

	test("multi-term search matches pages containing all terms without requiring an exact phrase", async () => {
		const { app, storage } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});
		const crawl = storage.repos.crawlRuns.createRun(
			"crawl-search-terms",
			"https://example.com",
			crawlBody,
		);

		for (const [slug, mainContent] of [
			["phrase", "alpha beta"],
			["separated", "alpha gamma beta"],
			["partial", "alpha only"],
		]) {
			storage.repos.pages.save({
				crawlId: crawl.id,
				url: `https://example.com/${slug}`,
				domain: "example.com",
				contentType: "text/html",
				statusCode: 200,
				contentLength: 128,
				title: slug,
				description: "Search term contract",
				content: `<main>${mainContent}</main>`,
				isDynamic: false,
				lastModified: null,
				etag: null,
				processedContent: {
					extractedData: { mainContent },
					metadata: {},
					analysis: {},
					media: [],
					links: [],
					errors: [],
				},
				links: [],
			});
		}

		const response = await app.handle(
			new Request("http://localhost/api/search?q=alpha%20beta"),
		);

		expect(response.status).toBe(200);
		const search = await response.json();
		expect(search.count).toBe(2);
		expect(
			search.results.map((result: { url: string }) => result.url).sort(),
		).toEqual(["https://example.com/phrase", "https://example.com/separated"]);
	});

	test("search returns string snippets for content-only pages", async () => {
		const { app, storage } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});
		const crawl = storage.repos.crawlRuns.createRun(
			"crawl-content-only-api-search",
			"https://content-only.example",
			{
				...crawlBody,
				target: "https://content-only.example",
				contentOnly: true,
			},
		);
		storage.repos.pages.save({
			crawlId: crawl.id,
			url: "https://content-only.example/page",
			domain: "content-only.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 128,
			title: "Stored without source",
			description: "",
			content: null,
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "uniquecontentonlyneedle body" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		});

		const response = await app.handle(
			new Request("http://localhost/api/search?q=uniquecontentonlyneedle"),
		);

		expect(response.status).toBe(200);
		const search = await response.json();
		expect(search.results[0].snippet).toContain("uniquecontentonlyneedle");
	});

	test("resume rejects terminal crawls", async () => {
		const { app, storage } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>done</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const createResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(crawlBody),
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
			fetch: async () =>
				new Response("<html><body><main>done</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const createResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(crawlBody),
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

	test("resume rejects already-active crawl records", async () => {
		const { app, registry, storage } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const paused = storage.repos.crawlRuns.createRun(
			"active-paused-crawl",
			"https://paused.example",
			{ ...crawlBody, target: "https://paused.example" },
		);
		storage.repos.crawlRuns.markPaused(paused.id, paused.counters, "Paused", 0);
		registry.set(paused.id, {} as CrawlRuntime);

		const resumeResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${paused.id}/resume`, {
				method: "POST",
			}),
		);

		expect(resumeResponse.status).toBe(409);
		expect(await resumeResponse.json()).toEqual({
			error: "Crawl is already running",
		});
	});

	test("delete rejects persisted active crawl records without relying on the runtime registry", async () => {
		const { app, storage } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const active = storage.repos.crawlRuns.createRun(
			"orphan-running-crawl",
			"https://running.example",
			{ ...crawlBody, target: "https://running.example" },
		);
		storage.repos.crawlRuns.markRunning(active.id, active.counters, 0);

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

	test("resumable crawl endpoint returns only settled paused and interrupted runs from one snapshot", async () => {
		const { app, registry, storage } = buildApp({
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});

		const paused = storage.repos.crawlRuns.createRun(
			"paused-crawl",
			"https://paused.example",
			{ ...crawlBody, target: "https://paused.example" },
		);
		const pausing = storage.repos.crawlRuns.createRun(
			"pausing-crawl",
			"https://pausing.example",
			{ ...crawlBody, target: "https://pausing.example" },
		);
		const interrupted = storage.repos.crawlRuns.createRun(
			"interrupted-crawl",
			"https://interrupted.example",
			{ ...crawlBody, target: "https://interrupted.example" },
		);
		const completed = storage.repos.crawlRuns.createRun(
			"completed-crawl",
			"https://completed.example",
			{ ...crawlBody, target: "https://completed.example" },
		);
		const activePaused = storage.repos.crawlRuns.createRun(
			"active-paused-crawl",
			"https://active-paused.example",
			{ ...crawlBody, target: "https://active-paused.example" },
		);
		storage.repos.crawlRuns.markPaused(paused.id, paused.counters, "Paused", 0);
		storage.repos.crawlRuns.markPaused(
			activePaused.id,
			activePaused.counters,
			"Shutdown still settling",
			0,
		);
		storage.repos.crawlRuns.markPausing(
			pausing.id,
			pausing.counters,
			"Pause requested",
			0,
		);
		storage.repos.crawlRuns.markInterrupted(
			interrupted.id,
			interrupted.counters,
			"Shutdown",
			0,
		);
		storage.repos.crawlRuns.markCompleted(
			completed.id,
			completed.counters,
			null,
			0,
		);
		registry.set(activePaused.id, {} as CrawlRuntime);

		const response = await app.handle(
			new Request("http://localhost/api/crawls/resumable"),
		);

		expect(response.status).toBe(200);
		const listed = await response.json();
		expect(
			listed.crawls.map((crawl: { id: string }) => crawl.id).sort(),
		).toEqual(["interrupted-crawl", "paused-crawl"]);
	});

	test("sse delivers ordered events and disconnect does not stop the crawl", async () => {
		let releaseFetch!: () => void;
		const { app, storage } = buildApp({
			fetch: () =>
				new Promise<Response>((resolve) => {
					releaseFetch = () =>
						resolve(
							new Response("<html><body><main>stream</main></body></html>", {
								status: 200,
								headers: { "content-type": "text/html" },
							}),
						);
				}),
		});

		const createResponse = await app.handle(
			new Request("http://localhost/api/crawls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...crawlBody, maxPages: 1 }),
			}),
		);
		const created = await createResponse.json();

		const sseResponse = await app.handle(
			new Request(`http://localhost/api/crawls/${created.id}/events`),
		);
		const reader = sseResponse.body?.getReader();
		expect(reader).toBeTruthy();
		if (!reader) {
			throw new Error("Expected SSE reader to be available");
		}

		releaseFetch();
		const firstChunk = await reader.read();
		expect(new TextDecoder().decode(firstChunk.value)).toContain(
			"event: crawl.started",
		);
		await reader.cancel();

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);
		expect(completed?.status).toBe("completed");
	});
});
