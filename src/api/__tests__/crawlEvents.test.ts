import { describe, expect, test } from "bun:test";
import { parseCrawlEventEnvelope } from "../crawlEvents";

describe("crawl event parser", () => {
	test("parses valid progress envelopes against the shared contract", () => {
		const event = parseCrawlEventEnvelope(
			JSON.stringify({
				type: "crawl.progress",
				crawlId: "crawl-1",
				sequence: 3,
				timestamp: "2026-03-21T12:00:00.000Z",
				payload: {
					counters: {
						pagesScanned: 1,
						successCount: 1,
						failureCount: 0,
						skippedCount: 0,
						linksFound: 2,
						mediaFiles: 0,
						totalDataKb: 4,
					},
					queue: {
						activeRequests: 1,
						queueLength: 2,
						elapsedTime: 1,
						pagesPerSecond: 1,
					},
					elapsedSeconds: 1,
					pagesPerSecond: 1,
					stopReason: null,
				},
			}),
		);

		expect(event?.type).toBe("crawl.progress");
	});

	test("rejects envelopes with malformed payloads", () => {
		const event = parseCrawlEventEnvelope(
			JSON.stringify({
				type: "crawl.progress",
				crawlId: "crawl-1",
				sequence: 3,
				timestamp: "2026-03-21T12:00:00.000Z",
				payload: {
					counters: {
						pagesScanned: "broken",
					},
				},
			}),
		);

		expect(event).toBeNull();
	});
});
