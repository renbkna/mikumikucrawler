import { describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import type { AppLogger } from "../../config/logging.js";
import { handleAppError } from "../../errorHandling.js";
import { dbPlugin } from "../../plugins/db.js";
import type { HttpClient, Resolver } from "../../plugins/security.js";
import { securityPlugin } from "../../plugins/security.js";
import { servicesPlugin } from "../../plugins/services.js";
import { loggerPlugin } from "../../plugins/logger.js";
import { CrawlManager } from "../../runtime/CrawlManager.js";
import { EventStream } from "../../runtime/EventStream.js";
import { RuntimeRegistry } from "../../runtime/RuntimeRegistry.js";
import { createInMemoryStorage } from "../../storage/db.js";
import { crawlsApi } from "../crawls.js";
import { pagesApi } from "../pages.js";
import { searchApi } from "../search.js";
import { sseApi } from "../sse.js";

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

	const app = new Elysia()
		.use(loggerPlugin(logger))
		.use(dbPlugin(storage))
		.use(securityPlugin(resolver, httpClient))
		.use(
			servicesPlugin({
				crawlManager,
				eventStream,
				runtimeRegistry: registry,
			}),
		)
		.onError(({ code, error, logger, set }) =>
			handleAppError({
				code,
				error,
				set,
				logger,
			}),
		)
		.use(crawlsApi())
		.use(sseApi())
		.use(pagesApi())
		.use(searchApi());

	return { app, crawlManager, storage };
}

const crawlBody = {
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
