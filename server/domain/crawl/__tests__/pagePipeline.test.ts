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
				scheduleRetry: mock(() => undefined),
			} as never,
			{
				getLinksByPageUrl: () => [],
			} as never,
			{
				fetch: async () => ({
					type: "blocked",
					statusCode: 403,
					reason:
						"Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
				}),
			} as never,
			{
				isAllowed: async () => true,
				getCrawlDelay: async () => null,
			} as never,
			eventSink,
			createLogger(),
		);

		await pipeline.process({
			url: "https://www.youtube.com/watch?v=test",
			domain: "www.youtube.com",
			depth: 0,
			retries: 0,
		});

		expect(state.adaptDomainDelay).toHaveBeenCalledWith("www.youtube.com", 403);
		expect(state.recordTerminal).toHaveBeenCalledWith(
			"https://www.youtube.com/watch?v=test",
			"failure",
		);
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

		await pipeline.process({
			url: "https://example.com/overflow",
			domain: "example.com",
			depth: 1,
			retries: 0,
		});

		expect(recordTerminal).toHaveBeenCalledWith(
			"https://example.com/overflow",
			"skip",
		);
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Limit] Max pages reached: https://example.com/overflow",
		);
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
				fetch: async (
					_crawlId: string,
					_item: unknown,
					signal?: AbortSignal,
				) => {
					controller.abort(new Error("timeout"));
					if (!signal) {
						throw new Error("Expected signal");
					}
					return {
						type: "success",
						content: "<html><body><main>late</main></body></html>",
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
		expect(result.page?.eventPayload.id).toBeNull();
		expect(recordDomainPage).toHaveBeenCalledWith("example.com");
		expect(recordTerminal).toHaveBeenCalledWith(
			"https://example.com/",
			"success",
			expect.objectContaining({ dataKb: 0, mediaFiles: 0 }),
		);
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Crawler] Crawled https://example.com/",
		);
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
		expect(recordTerminal).toHaveBeenCalledWith(
			"https://example.com/post",
			"success",
			expect.objectContaining({ mediaFiles: 0 }),
		);
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
		expect(recordTerminal).toHaveBeenCalledWith(
			"https://example.com/post",
			"success",
			expect.objectContaining({ mediaFiles: 1 }),
		);
		expect(result.page?.eventPayload.processedData?.media).toHaveLength(1);
		expect(eventSink.page).not.toHaveBeenCalled();
	});
});
