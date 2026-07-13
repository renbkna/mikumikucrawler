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
	test("surfaces blocked fetch reasons to the event sink", async () => {
		const eventSink = {
			log: mock(() => undefined),
			page: mock(() => undefined),
		};
		const state = {
			canScheduleMore: () => true,
			hasVisited: () => false,
			isDomainBudgetExceeded: () => false,
			adaptDomainDelay: mock(() => undefined),
			recordTerminal: mock(() => undefined),
			recordDomainPage: mock(() => undefined),
		};
		const pipeline = new PagePipeline(
			"crawl-1",
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
				getLinksByPageUrl: () => [],
				getDiscoveredLinkCountByPageUrl: () => 3,
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
		expect(eventSink.page).not.toHaveBeenCalled();
	});

	test("records a skipped terminal outcome when max pages has already been reached", async () => {
		const eventSink = {
			log: mock(() => undefined),
			page: mock(() => undefined),
		};
		const recordTerminal = mock(() => true);
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
			} as never,
			{
				enqueue: mock(() => undefined),
				enqueueNormalized: mock(() => true),
				scheduleRetry: mock(() => undefined),
			} as never,
			{} as never,
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

	test("unchanged cached pages count against the domain budget", async () => {
		const eventSink = {
			log: mock(() => undefined),
			page: mock(() => undefined),
		};
		const recordTerminal = mock(() => true);
		const recordDomainPage = mock(() => undefined);
		const recordDiscoveredLinks = mock(() => undefined);
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDomainPage,
				recordDiscoveredLinks,
			} as never,
			{
				enqueue: mock(() => undefined),
				enqueueNormalized: mock(() => true),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				getLinksByPageUrl: () => [],
				getDiscoveredLinkCountByPageUrl: () => 3,
			} as never,
			{
				fetch: async () => ({
					type: "unchanged",
					statusCode: 304,
					lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
					etag: '"abc"',
				}),
			} as never,
			{} as never,
			eventSink,
			createLogger(),
		);

		const result = await pipeline.process({
			url: "https://example.com/cached",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			terminalOutcome: "success",
			terminalEffects: { chargeDomainBudget: true, discoveredLinks: 3 },
		});
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Crawler] Unchanged: https://example.com/cached (304)",
		);
	});

	test("XHTML responses admit discovered links through the HTML pipeline", async () => {
		const eventSink = {
			log: mock(() => undefined),
			page: mock(() => undefined),
		};
		const enqueueNormalized = mock(() => true);
		const recordTerminal = mock(() => true);
		const recordDomainPage = mock(() => undefined);
		const recordDiscoveredLinks = mock(() => undefined);
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDomainPage,
				recordDiscoveredLinks,
			} as never,
			{
				enqueue: mock(() => undefined),
				enqueueNormalized,
				scheduleRetry: mock(() => undefined),
			} as never,
			{} as never,
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

	test("aborted processing does not persist or emit a late success", async () => {
		const eventSink = {
			log: mock(() => undefined),
			page: mock(() => undefined),
		};
		const save = mock(() => 1);
		const recordTerminal = mock(() => true);
		const controller = new AbortController();
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDiscoveredLinks: mock(() => undefined),
				recordDomainPage: mock(() => undefined),
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				save,
			} as never,
			{
				fetch: async (signal?: AbortSignal) => {
					controller.abort(new Error("timeout"));
					if (!signal) {
						throw new Error("Expected signal");
					}
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

		expect(save).not.toHaveBeenCalled();
		expect(recordTerminal).not.toHaveBeenCalled();
		expect(eventSink.page).not.toHaveBeenCalled();
	});

	test("small valid pages are not treated as soft 404s solely because they are short", async () => {
		const eventSink = {
			log: mock(() => undefined),
			page: mock(() => undefined),
		};
		const save = mock(() => 11);
		const recordTerminal = mock(() => true);
		const recordDomainPage = mock(() => undefined);
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDiscoveredLinks: mock(() => undefined),
				recordDomainPage,
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				save,
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

		expect(save).not.toHaveBeenCalled();
		expect(result.page?.saveInput.url).toBe("https://example.com/");
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

	test("rendered client error shells are terminal failures and are not persisted", async () => {
		const eventSink = {
			log: mock(() => undefined),
			page: mock(() => undefined),
		};
		const recordTerminal = mock(() => true);
		const recordDomainPage = mock(() => undefined);
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDomainPage,
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry: mock(() => undefined),
			} as never,
			{} as never,
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
			page: mock(() => undefined),
		};
		const recordTerminal = mock(() => true);
		const recordDomainPage = mock(() => undefined);
		const recordDiscoveredLinks = mock(() => undefined);
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDomainPage,
				recordDiscoveredLinks,
			} as never,
			{
				enqueue: mock(() => undefined),
				enqueueNormalized: mock(() => true),
				scheduleRetry: mock(() => undefined),
			} as never,
			{} as never,
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
		expect(recordDiscoveredLinks).not.toHaveBeenCalled();
	});

	test("abort during noindex link admission does not record a terminal skip", async () => {
		const eventSink = {
			log: mock(() => undefined),
			page: mock(() => undefined),
		};
		const recordTerminal = mock(() => true);
		const controller = new AbortController();
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDomainPage: mock(() => undefined),
				setDomainDelay: mock(() => undefined),
			} as never,
			{
				enqueue: mock(() => undefined),
				enqueueNormalized: mock(() => true),
				scheduleRetry: mock(() => undefined),
			} as never,
			{} as never,
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

		expect(recordTerminal).not.toHaveBeenCalled();
	});

	test("saveMedia=false strips extracted media from persisted and emitted page data", async () => {
		const eventSink = {
			log: mock(() => undefined),
			page: mock(() => undefined),
		};
		const recordTerminal = mock(() => true);
		const save = mock(() => 7);
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDiscoveredLinks: mock(() => undefined),
				recordDomainPage: mock(() => undefined),
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				save,
			} as never,
			{
				fetch: async () => ({
					type: "success",
					content:
						'<html><body><main>This is a long enough article body to exercise the successful persistence path during the contract test execution path.</main><img src="/image.png" alt="cover" /></body></html>',
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

		expect(save).not.toHaveBeenCalled();
		expect(result.page?.saveInput.processedContent.media).toEqual([]);
		expect(result).toMatchObject({
			terminalOutcome: "success",
			terminalEffects: { chargeDomainBudget: true, mediaFiles: 0 },
		});
		expect(result.page?.eventPayload.processedData?.media).toEqual([]);
		expect(eventSink.page).not.toHaveBeenCalled();
	});

	test("media mode with saveMedia=true keeps extracted media metadata", async () => {
		const eventSink = {
			log: mock(() => undefined),
			page: mock(() => undefined),
		};
		const recordTerminal = mock(() => true);
		const save = mock(() => 8);
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDiscoveredLinks: mock(() => undefined),
				recordDomainPage: mock(() => undefined),
			} as never,
			{
				enqueue: mock(() => undefined),
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				save,
			} as never,
			{
				fetch: async () => ({
					type: "success",
					content:
						'<html><body><main>This is a long enough article body to exercise the successful persistence path during the contract test execution path.</main><img src="/image.png" alt="cover" /></body></html>',
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

		expect(save).not.toHaveBeenCalled();
		expect(result.page?.saveInput.processedContent.media).toHaveLength(1);
		expect(result).toMatchObject({
			terminalOutcome: "success",
			terminalEffects: { chargeDomainBudget: true, mediaFiles: 1 },
		});
		expect(result.page?.eventPayload.processedData?.media).toHaveLength(1);
		expect(eventSink.page).not.toHaveBeenCalled();
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
			"crawl-1",
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
			{} as never,
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
			"crawl-1",
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
			{} as never,
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

	test("resolves relative links from the effective document URL while preserving requested identity", async () => {
		const enqueueNormalized = mock(() => true);
		const recordTerminal = mock(() => true);
		const pipeline = new PagePipeline(
			"crawl-1",
			{
				crawlDepth: 1,
				retryLimit: 0,
				respectRobots: false,
				saveMedia: false,
				crawlMethod: "full",
				contentOnly: false,
			} as never,
			{
				canScheduleMore: () => true,
				hasVisited: () => false,
				isDomainBudgetExceeded: () => false,
				recordTerminal,
				recordDomainPage: mock(() => undefined),
				recordDiscoveredLinks: mock(() => undefined),
			} as never,
			{
				enqueueNormalized,
				scheduleRetry: mock(() => undefined),
			} as never,
			{} as never,
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
		expect(result.page?.saveInput.url).toBe("https://example.com/start");
		expect(result.page?.saveInput.processedContent.url).toBe(
			"https://final.example/docs/index.html",
		);
	});

	test("rejects large HTML shells without readable content or link admission", async () => {
		const enqueueNormalized = mock(() => true);
		const recordTerminal = mock(() => true);
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDomainPage: mock(() => undefined),
				recordDiscoveredLinks: mock(() => undefined),
			} as never,
			{ enqueueNormalized, scheduleRetry: mock(() => undefined) } as never,
			{} as never,
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
		const recordTerminal = mock(() => true);
		const pipeline = new PagePipeline(
			"crawl-1",
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
				recordTerminal,
				recordDomainPage: mock(() => undefined),
			} as never,
			{ scheduleRetry: mock(() => undefined) } as never,
			{} as never,
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
