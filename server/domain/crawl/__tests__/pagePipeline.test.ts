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
});
