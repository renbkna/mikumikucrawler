import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../../config/logging.js";
import { PagePipeline } from "../PagePipeline.js";

function createLogger(): Logger {
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
	} as unknown as Logger;
}

describe("page pipeline contract", () => {
	test("records unsupported response types as skipped pages", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{} as never,
			{
				fetch: async () => ({
					type: "unsupported",
					statusCode: 200,
					contentType: "application/x-apple-diskimage",
				}),
			} as never,
			{} as never,
			eventSink,
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/download",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toMatchObject({ terminalOutcome: "skip" });
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Crawler] Unsupported content type application/x-apple-diskimage: https://example.com/download",
		);
	});

	test("surfaces blocked fetch reasons to the event sink", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const state = {
			canScheduleMore: () => true,
			hasVisited: () => false,
			isDomainBudgetExceeded: () => false,
			adaptDomainDelay: mock(() => undefined),
		};
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "text",
				contentOnly: false,
			} as never,
			state as never,
			{
				enqueue: mock(() => undefined),
				enqueueNormalized: mock(() => true),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: async () => ({
					type: "blocked",
					statusCode: 403,
					reason: "Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
				}),
			} as never,
			{
				isAllowed: async () => true,
				getCrawlDelay: async () => null,
			} as never,
			eventSink,
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://www.youtube.com/watch?v=test",
			domain: "www.youtube.com",
			depth: 0,
			retries: 0,
		});

		expect(state.adaptDomainDelay).toHaveBeenCalledWith("https://www.youtube.com", 403);
		expect(result).toMatchObject({
			terminalOutcome: "failure",
			terminalEffects: { chargeDomainBudget: true },
		});
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Crawler] Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
		);
	});

	test("records a skipped terminal outcome when max pages has already been reached", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => false,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{
				enqueue: mock(() => undefined),
				enqueueNormalized: mock(() => true),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: mock(async () => {
					throw new Error("fetch should not be called");
				}),
			} as never,
			{} as never,
			eventSink,
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/overflow",
			domain: "example.com",
			depth: 1,
			retries: 0,
		});

		expect(result).toEqual({
			terminalOutcome: "skip",
			terminalEffects: { chargeDomainBudget: false },
		});
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Limit] Max pages reached: https://example.com/overflow",
		);
	});

	test("contains restored work beyond the domain budget as an observable uncharged skip", async () => {
		const eventSink = { log: mock(() => undefined) };
		const fetch = mock(async () => {
			throw new Error("fetch should not be called");
		});
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => true,
			} as never,
			{} as never,
			{ fetch } as never,
			{} as never,
			eventSink,
			createLogger(),
		);
		const item = {
			url: "https://example.com/restored-excess",
			domain: "example.com",
			depth: 1,
			retries: 0,
		};

		await expect(pipeline.process(item)).resolves.toEqual({
			terminalOutcome: "skip",
			terminalEffects: { chargeDomainBudget: false },
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Budget] Domain budget exceeded: https://example.com/restored-excess",
		);
	});

	test("rejects a terminal URL that re-enters the runtime queue", async () => {
		const fetch = mock(async () => {
			throw new Error("fetch should not be called");
		});
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				hasVisited: () => true,
			} as never,
			{} as never,
			{ fetch } as never,
			{} as never,
			{ log: mock(() => undefined) },
			createLogger(),
		);
		const item = {
			url: "https://example.com/already-terminal",
			domain: "example.com",
			depth: 0,
			retries: 0,
		};

		await expect(pipeline.process(item)).rejects.toThrow(
			"Queued URL is already terminal: https://example.com/already-terminal",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("XHTML responses admit discovered links through the HTML pipeline", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const enqueueNormalized = mock(() => true);
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{
				enqueue: mock(() => undefined),
				enqueueNormalized,
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: async () => ({
					type: "success",
					content: '<html><body><main>XHTML</main><a href="/next">Next</a></body></html>',
					effectiveUrl: "https://example.com/page",
					statusCode: 200,
					contentType: "application/xhtml+xml; charset=utf-8",
					contentLength: 75,
					title: "",
					description: "",
					lastModified: null,
					etag: null,
					xRobotsTag: null,
					isDynamic: false,
				}),
			} as never,
			{} as never,
			eventSink,
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/page",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(enqueueNormalized).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/next",
				domain: "example.com",
				depth: 1,
			}),
		);
		expect(result).toMatchObject({
			terminalOutcome: "success",
			terminalEffects: { chargeDomainBudget: true, discoveredLinks: 1 },
		});
	});

	test("aborted processing rejects before returning a late success", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const controller = new AbortController();
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: async (_item: unknown, signal?: AbortSignal) => {
					expect(signal).toBe(controller.signal);
					controller.abort(new Error("timeout"));
					return {
						type: "success",
						content: "<html><body><main>late</main></body></html>",
						effectiveUrl: "https://example.com/late",
						statusCode: 200,
						contentType: "text/html",
						contentLength: 44,
						title: "",
						description: "",
						lastModified: null,
						etag: null,
						xRobotsTag: null,
						isDynamic: false,
					} as const;
				},
			} as never,
			{} as never,
			eventSink,
			createLogger(),
		);

		await expect(
			pipeline.process(
				{
					url: "https://example.com/late",
					domain: "example.com",
					depth: 0,
					retries: 0,
				},
				controller.signal,
			),
		).rejects.toThrow("timeout");
	});

	test("small valid pages are not treated as soft 404s solely because they are short", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: async () => ({
					type: "success",
					content: "<html><body><main>Hello world</main></body></html>",
					effectiveUrl: "https://example.com/",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 50,
					title: "",
					description: "",
					lastModified: null,
					etag: null,
					xRobotsTag: null,
					isDynamic: false,
				}),
			} as never,
			{} as never,
			eventSink,
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.page?.eventPayload.url).toBe("https://example.com/");
		expect(result.page?.eventPayload).not.toHaveProperty("id");
		expect(result).toMatchObject({
			terminalOutcome: "success",
			terminalEffects: {
				chargeDomainBudget: true,
				dataKb: 0,
				mediaFiles: 0,
			},
		});
		expect(eventSink.log).toHaveBeenCalledWith("[Crawler] Crawled https://example.com/");
	});

	test("rendered client error shells return terminal failure without page data", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
				adaptDomainDelay: mock(() => undefined),
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: async () => ({
					type: "success",
					content:
						"<html><body><main>Oops! Something went wrong Miku encountered an unexpected error Try Again Reload Page</main></body></html>",
					effectiveUrl: "https://example.com/crashed-app",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 270_622,
					title: "",
					description: "",
					lastModified: null,
					etag: null,
					xRobotsTag: null,
					isDynamic: true,
				}),
			} as never,
			{} as never,
			eventSink,
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/crashed-app",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			terminalOutcome: "failure",
			terminalEffects: { chargeDomainBudget: true },
		});
		expect(result.page).toBeUndefined();
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Crawler] Client error shell detected: https://example.com/crashed-app",
		);
	});

	test("noindex terminal pages count against the domain budget", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{
				enqueue: mock(() => undefined),
				enqueueNormalized: mock(() => true),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: async () => ({
					type: "success",
					content:
						'<html><head><meta name="robots" content="noindex"></head><body><main>Do not index this page.</main><a href="/next">next</a></body></html>',
					effectiveUrl: "https://example.com/noindex",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 1200,
					title: "",
					description: "",
					lastModified: null,
					etag: null,
					xRobotsTag: null,
					isDynamic: false,
				}),
			} as never,
			{} as never,
			eventSink,
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/noindex",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			terminalOutcome: "skip",
			terminalEffects: { chargeDomainBudget: true },
		});
	});

	test("abort during noindex link admission rejects before terminal classification", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const controller = new AbortController();
		const pipeline = new PagePipeline(
			{
				target: "https://example.com",
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: true,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
				setDomainDelay: mock(() => undefined),
			} as never,
			{
				enqueue: mock(() => undefined),
				enqueueNormalized: mock(() => true),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: async () => ({
					type: "success",
					content:
						'<html><head><meta name="robots" content="noindex"></head><body><main>Do not index this page.</main><a href="/next">next</a></body></html>',
					effectiveUrl: "https://example.com/noindex",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 1200,
					title: "",
					description: "",
					lastModified: null,
					etag: null,
					xRobotsTag: null,
					isDynamic: false,
				}),
			} as never,
			{
				evaluateIdentity: mock(async () => {
					controller.abort(new Error("force stop"));
					throw new Error("force stop");
				}),
			} as never,
			eventSink,
			createLogger(),
		);

		await expect(
			pipeline.process(
				{
					url: "https://example.com/noindex",
					domain: "example.com",
					depth: 0,
					retries: 0,
				},
				controller.signal,
			),
		).rejects.toThrow("force stop");
	});

	test("saveMedia=false strips extracted media from returned page data", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "media",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: async () => ({
					type: "success",
					content:
						'<html><body><main>This is a long enough article body to exercise page-result construction during the contract test execution path.</main><img src="/image.png" alt="cover" /></body></html>',
					effectiveUrl: "https://example.com/post",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 4000,
					title: "",
					description: "",
					lastModified: null,
					etag: null,
					xRobotsTag: null,
					isDynamic: false,
				}),
			} as never,
			{} as never,
			eventSink,
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/post",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.page?.pageData.processedContent.media).toEqual([]);
		expect(result).toMatchObject({
			terminalOutcome: "success",
			terminalEffects: { chargeDomainBudget: true, mediaFiles: 0 },
		});
		expect(result.page?.eventPayload.processedData?.media).toEqual([]);
	});

	test("media mode with saveMedia=true keeps extracted media metadata", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: true,
				crawlMethod: "media",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: async () => ({
					type: "success",
					content:
						'<html><body><main>This is a long enough article body to exercise page-result construction during the contract test execution path.</main><img src="/image.png" alt="cover" /></body></html>',
					effectiveUrl: "https://example.com/post",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 4000,
					title: "",
					description: "",
					lastModified: null,
					etag: null,
					xRobotsTag: null,
					isDynamic: false,
				}),
			} as never,
			{} as never,
			eventSink,
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/post",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.page?.pageData.processedContent.media).toHaveLength(1);
		expect(result).toMatchObject({
			terminalOutcome: "success",
			terminalEffects: { chargeDomainBudget: true, mediaFiles: 1 },
		});
		expect(result.page?.eventPayload.processedData?.media).toHaveLength(1);
	});

	test("reschedules transient fetch failures through the queue retry path", async () => {
		const scheduleRetry = mock(() => undefined);
		const item = {
			url: "https://example.com/",
			domain: "example.com",
			depth: 0,
			retries: 0,
		};
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 1,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
				adaptDomainDelay: mock(() => undefined),
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry,
			} as never,
			{
				fetch: async () => ({
					type: "transientFailure",
					statusCode: 500,
				}),
			} as never,
			{} as never,
			{ log: mock(() => undefined) },
			createLogger(),
		);

		await expect(pipeline.process(item)).resolves.toEqual({
			rescheduled: true,
		});
		expect(scheduleRetry).toHaveBeenCalledWith(item, 1000);
	});

	test("owns retry fallback timing for rate limits without retry-after", async () => {
		const scheduleRetry = mock(() => undefined);
		const adaptDomainDelay = mock(() => undefined);
		const item = {
			url: "https://example.com/",
			domain: "example.com",
			depth: 0,
			retries: 1,
		};
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 2,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
				adaptDomainDelay,
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry,
			} as never,
			{
				fetch: async () => ({
					type: "rateLimited",
					statusCode: 429,
				}),
			} as never,
			{} as never,
			{ log: mock(() => undefined) },
			createLogger(),
		);

		await expect(pipeline.process(item)).resolves.toEqual({
			rescheduled: true,
		});
		expect(scheduleRetry).toHaveBeenCalledWith(item, 2000);
		expect(adaptDomainDelay).toHaveBeenCalledWith("https://example.com", 429, 2000);
	});

	test("classifies redirected links against the effective document while preserving requested identity", async () => {
		const enqueueNormalized = mock(() => true);
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{
				enqueueNormalized,
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				fetch: async () => ({
					type: "success",
					content: '<html><main>Redirected article</main><a href="child">child</a></html>',
					effectiveUrl: "https://final.example/docs/index.html",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 2000,
					title: "",
					description: "",
					lastModified: null,
					etag: null,
					xRobotsTag: null,
					isDynamic: false,
				}),
			} as never,
			{} as never,
			{ log: mock(() => undefined) },
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/start",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(enqueueNormalized).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://final.example/docs/child" }),
		);
		expect(result.page?.eventPayload.url).toBe("https://example.com/start");
		expect(result.page?.pageData.processedContent.url).toBe(
			"https://final.example/docs/index.html",
		);
	});

	test("rejects large HTML shells without readable content or link admission", async () => {
		const enqueueNormalized = mock(() => true);
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{ enqueueNormalized, scheduleRetry: mock(() => undefined) } as never,
			{
				fetch: async () => ({
					type: "success",
					content: `<html><body><nav><a href="/shell-link">link</a></nav><script>${"x".repeat(2000)}</script></body></html>`,
					effectiveUrl: "https://example.com/shell",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 2100,
					title: "",
					description: "",
					lastModified: null,
					etag: null,
					xRobotsTag: null,
					isDynamic: true,
				}),
			} as never,
			{} as never,
			{ log: mock(() => undefined) },
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/shell",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toMatchObject({ terminalOutcome: "failure" });
		expect(enqueueNormalized).not.toHaveBeenCalled();
		expect(result.page).toBeUndefined();
	});

	test("consumes structured processor errors as terminal failure", async () => {
		const pipeline = new PagePipeline(
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "links",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
			} as never,
			{ scheduleRetry: mock(() => undefined) } as never,
			{
				fetch: async () => ({
					type: "success",
					content: Buffer.from("not a pdf"),
					effectiveUrl: "https://example.com/broken.pdf",
					statusCode: 200,
					contentType: "application/pdf",
					contentLength: 1000,
					title: "",
					description: "",
					lastModified: null,
					etag: null,
					xRobotsTag: null,
					isDynamic: false,
				}),
			} as never,
			{} as never,
			{ log: mock(() => undefined) },
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/broken.pdf",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toMatchObject({ terminalOutcome: "failure" });
		expect(result).toMatchObject({ terminalEffects: { chargeDomainBudget: true } });
		expect(result.page).toBeUndefined();
	});
});
