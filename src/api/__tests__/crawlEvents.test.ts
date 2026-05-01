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

	test("parses paused lifecycle envelopes", () => {
		const event = parseCrawlEventEnvelope(
			JSON.stringify({
				type: "crawl.paused",
				crawlId: "crawl-1",
				sequence: 4,
				timestamp: "2026-03-21T12:01:00.000Z",
				payload: {
					stopReason: "Pause requested",
					counters: {
						pagesScanned: 1,
						successCount: 1,
						failureCount: 0,
						skippedCount: 0,
						linksFound: 2,
						mediaFiles: 0,
						totalDataKb: 4,
					},
				},
			}),
		);

		expect(event?.type).toBe("crawl.paused");
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

	test("rejects progress payloads looser than the server numeric schema", () => {
		const event = parseCrawlEventEnvelope(
			JSON.stringify({
				type: "crawl.progress",
				crawlId: "crawl-1",
				sequence: 3,
				timestamp: "2026-03-21T12:00:00.000Z",
				payload: {
					counters: {
						pagesScanned: -1,
						successCount: 0,
						failureCount: 0,
						skippedCount: 0,
						linksFound: 0,
						mediaFiles: 0,
						totalDataKb: 0,
					},
					queue: {
						activeRequests: -1,
						queueLength: 0,
						elapsedTime: 0,
						pagesPerSecond: -1,
					},
					elapsedSeconds: -1,
					pagesPerSecond: -1,
					stopReason: null,
				},
			}),
		);

		expect(event).toBeNull();
	});

	test("rejects malformed page payload fields", () => {
		const event = parseCrawlEventEnvelope(
			JSON.stringify({
				type: "crawl.page",
				crawlId: "crawl-1",
				sequence: 5,
				timestamp: "2026-03-21T12:02:00.000Z",
				payload: {
					id: null,
					url: "https://example.com/page",
					title: 123,
				},
			}),
		);

		expect(event).toBeNull();
	});

	test("rejects page payload ids looser than the server numeric schema", () => {
		const event = parseCrawlEventEnvelope(
			JSON.stringify({
				type: "crawl.page",
				crawlId: "crawl-1",
				sequence: 5,
				timestamp: "2026-03-21T12:02:00.000Z",
				payload: {
					id: 1.5,
					url: "https://example.com/page",
				},
			}),
		);

		expect(event).toBeNull();
	});

	test("rejects malformed nested processed page data", () => {
		const event = parseCrawlEventEnvelope(
			JSON.stringify({
				type: "crawl.page",
				crawlId: "crawl-1",
				sequence: 5,
				timestamp: "2026-03-21T12:02:00.000Z",
				payload: {
					id: 1,
					url: "https://example.com/page",
					processedData: {
						extractedData: {},
						metadata: {},
						analysis: {},
						media: [],
						errors: { length: 1 },
						qualityScore: 0,
						language: "unknown",
					},
				},
			}),
		);

		expect(event).toBeNull();
	});
});
