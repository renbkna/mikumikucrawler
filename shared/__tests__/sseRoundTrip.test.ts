import { describe, expect, test } from "bun:test";
import type { CrawlEventEnvelope } from "../contracts/index.js";
import { createEventStreamResponse } from "../../server/plugins/sse.js";
import { EventStream } from "../../server/runtime/EventStream.js";
import { parseCrawlEventEnvelope } from "../../src/api/crawlEvents.js";

/**
 * Round-trip contract test: verifies that events published by EventStream pass
 * through the real SSE response framing and are correctly parsed from the
 * frontend EventSource payload.
 */
describe("SSE round-trip: EventStream → SSE response → parseCrawlEventEnvelope", () => {
	const decoder = new TextDecoder();

	async function readFirstSsePayload(response: Response): Promise<string> {
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(response.body).not.toBeNull();

		const reader = response.body!.getReader();
		try {
			const { value, done } = await reader.read();
			expect(done).toBe(false);
			expect(value).toBeDefined();

			const wire = decoder.decode(value);
			expect(wire).toContain("\n\n");
			expect(wire).toContain("id: ");
			expect(wire).toContain("event: ");

			const dataLine = wire
				.split("\n")
				.find((line) => line.startsWith("data: "));
			expect(dataLine).toBeDefined();
			return dataLine!.slice("data: ".length);
		} finally {
			await reader.cancel();
		}
	}

	function roundTrip(stream: EventStream, crawlId: string) {
		return async <TType extends Parameters<EventStream["publish"]>[1]>(
			type: TType,
			payload: Parameters<EventStream["publish"]>[2],
		) => {
			const published = stream.publish(crawlId, type, payload as never);
			const response = createEventStreamResponse({
				crawlId,
				eventStream: stream,
				afterSequence: published.sequence - 1,
				requestSignal: new AbortController().signal,
			});
			return parseCrawlEventEnvelope(await readFirstSsePayload(response));
		};
	}

	/** Narrows the parsed envelope to a specific event type for type-safe assertions. */
	function expectEnvelope<T extends CrawlEventEnvelope["type"]>(
		envelope: CrawlEventEnvelope | null,
		type: T,
	): Extract<CrawlEventEnvelope, { type: T }> {
		expect(envelope).not.toBeNull();
		expect(envelope!.type).toBe(type);
		return envelope as Extract<CrawlEventEnvelope, { type: T }>;
	}

	test("crawl.started survives round-trip", async () => {
		const stream = new EventStream();
		stream.initialize("rt-1");
		const publish = roundTrip(stream, "rt-1");

		const parsed = expectEnvelope(
			await publish("crawl.started", {
				target: "https://example.com",
				resume: false,
			}),
			"crawl.started",
		);

		expect(parsed.crawlId).toBe("rt-1");
		expect(parsed.sequence).toBe(1);
		expect(parsed.payload).toEqual({
			target: "https://example.com",
			resume: false,
		});
	});

	test("crawl.progress survives round-trip with full counters and queue", async () => {
		const stream = new EventStream();
		stream.initialize("rt-2");
		const publish = roundTrip(stream, "rt-2");

		const counters = {
			pagesScanned: 12,
			successCount: 10,
			failureCount: 1,
			skippedCount: 1,
			linksFound: 40,
			mediaFiles: 3,
			totalDataKb: 128,
		};
		const queue = {
			activeRequests: 3,
			queueLength: 7,
			elapsedTime: 15,
			pagesPerSecond: 0.8,
		};

		const parsed = expectEnvelope(
			await publish("crawl.progress", {
				counters,
				queue,
				elapsedSeconds: 15,
				pagesPerSecond: 0.8,
				stopReason: null,
			}),
			"crawl.progress",
		);

		expect(parsed.payload.counters).toEqual(counters);
		expect(parsed.payload.queue).toEqual(queue);
		expect(parsed.payload.stopReason).toBeNull();
	});

	test("crawl.page survives round-trip", async () => {
		const stream = new EventStream();
		stream.initialize("rt-3");
		const publish = roundTrip(stream, "rt-3");

		const parsed = expectEnvelope(
			await publish("crawl.page", {
				id: 42,
				url: "https://example.com/page",
				title: "Test Page",
				description: "A test page",
				domain: "example.com",
			}),
			"crawl.page",
		);

		expect(parsed.payload.id).toBe(42);
		expect(parsed.payload.url).toBe("https://example.com/page");
	});

	test("crawl.log survives round-trip", async () => {
		const stream = new EventStream();
		stream.initialize("rt-4");
		const publish = roundTrip(stream, "rt-4");

		const parsed = expectEnvelope(
			await publish("crawl.log", {
				message: "[Fetch] GET https://example.com → 200 (1.2s)",
			}),
			"crawl.log",
		);

		expect(parsed.payload.message).toBe(
			"[Fetch] GET https://example.com → 200 (1.2s)",
		);
	});

	test("crawl.completed survives round-trip", async () => {
		const stream = new EventStream();
		stream.initialize("rt-5");
		const publish = roundTrip(stream, "rt-5");

		const counters = {
			pagesScanned: 50,
			successCount: 48,
			failureCount: 2,
			skippedCount: 0,
			linksFound: 200,
			mediaFiles: 15,
			totalDataKb: 512,
		};

		const parsed = expectEnvelope(
			await publish("crawl.completed", { counters }),
			"crawl.completed",
		);

		expect(parsed.payload.counters).toEqual(counters);
	});

	test("crawl.failed survives round-trip", async () => {
		const stream = new EventStream();
		stream.initialize("rt-6");
		const publish = roundTrip(stream, "rt-6");

		const parsed = expectEnvelope(
			await publish("crawl.failed", {
				error: "Circuit breaker tripped: 20 consecutive failures",
				counters: {
					pagesScanned: 20,
					successCount: 0,
					failureCount: 20,
					skippedCount: 0,
					linksFound: 0,
					mediaFiles: 0,
					totalDataKb: 0,
				},
			}),
			"crawl.failed",
		);

		expect(parsed.payload.error).toBe(
			"Circuit breaker tripped: 20 consecutive failures",
		);
	});

	test("crawl.stopped survives round-trip", async () => {
		const stream = new EventStream();
		stream.initialize("rt-7");
		const publish = roundTrip(stream, "rt-7");

		const parsed = expectEnvelope(
			await publish("crawl.stopped", {
				stopReason: "User requested stop",
				counters: {
					pagesScanned: 10,
					successCount: 8,
					failureCount: 1,
					skippedCount: 1,
					linksFound: 30,
					mediaFiles: 2,
					totalDataKb: 64,
				},
			}),
			"crawl.stopped",
		);

		expect(parsed.payload.stopReason).toBe("User requested stop");
	});

	test("crawl.paused survives round-trip", async () => {
		const stream = new EventStream();
		stream.initialize("rt-8");
		const publish = roundTrip(stream, "rt-8");

		const parsed = expectEnvelope(
			await publish("crawl.paused", {
				stopReason: "Pause requested",
				counters: {
					pagesScanned: 10,
					successCount: 8,
					failureCount: 1,
					skippedCount: 1,
					linksFound: 30,
					mediaFiles: 2,
					totalDataKb: 64,
				},
			}),
			"crawl.paused",
		);

		expect(parsed.payload.stopReason).toBe("Pause requested");
	});

	test("sequence numbers are monotonic across event types", async () => {
		const stream = new EventStream();
		stream.initialize("rt-seq");
		const publish = roundTrip(stream, "rt-seq");

		const e1 = await publish("crawl.started", {
			target: "https://example.com",
			resume: false,
		});
		const e2 = await publish("crawl.log", { message: "fetching..." });
		const e3 = await publish("crawl.page", {
			id: 1,
			url: "https://example.com",
		});

		expect(e1!.sequence).toBe(1);
		expect(e2!.sequence).toBe(2);
		expect(e3!.sequence).toBe(3);
	});
});
