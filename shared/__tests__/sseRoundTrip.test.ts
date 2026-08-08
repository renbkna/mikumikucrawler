import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { createCrawlEventStream } from "../../server/plugins/sse.js";
import { EventStream } from "../../server/runtime/EventStream.js";
import type { CrawlEventEnvelope, CrawlEventType } from "../contracts/events.js";
import { parseCrawlEventEnvelope } from "../contracts/validation.js";

describe("SSE boundary", () => {
	function createResponse(stream: EventStream, crawlId: string, afterSequence = 0) {
		const app = new Elysia().get("/events", () =>
			createCrawlEventStream({ crawlId, eventStream: stream, afterSequence }),
		);
		return app.handle(new Request("http://localhost/events"));
	}

	async function readFirstPayload(
		response: Response,
		expectedType: CrawlEventType,
	): Promise<string> {
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected SSE response body");
		try {
			const { value, done } = await reader.read();
			expect(done).toBe(false);
			const wire =
				typeof value === "string"
					? value
					: value instanceof Uint8Array
						? new TextDecoder().decode(value)
						: "";
			expect(wire).toContain("id: ");
			expect(wire).toContain(`event: ${expectedType}`);
			const data = wire.split("\n").find((line) => line.startsWith("data: "));
			if (!data) throw new Error("Expected SSE data frame payload");
			return data.slice("data: ".length);
		} finally {
			await reader.cancel();
		}
	}

	test("round-trips every crawl event variant through real SSE framing", async () => {
		const counters = {
			pagesScanned: 1,
			successCount: 1,
			failureCount: 0,
			skippedCount: 0,
			linksFound: 2,
			mediaFiles: 0,
			totalDataKb: 4,
		};
		const events: Array<{
			type: CrawlEventType;
			publish(stream: EventStream, crawlId: string): CrawlEventEnvelope;
		}> = [
			{
				type: "crawl.started",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, "crawl.started", {
						target: "https://example.com/",
						resume: false,
					}),
			},
			{
				type: "crawl.progress",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, "crawl.progress", {
						counters,
						queue: {
							activeRequests: 1,
							queueLength: 2,
							elapsedTime: 1,
							pagesPerSecond: 1,
						},
						stopReason: null,
					}),
			},
			{
				type: "crawl.page",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, "crawl.page", {
						id: 1,
						pageCount: 1,
						url: "https://example.com/",
						details: {},
					}),
			},
			{
				type: "crawl.log",
				publish: (stream, crawlId) => stream.publish(crawlId, "crawl.log", { message: "ready" }),
			},
			{
				type: "crawl.completed",
				publish: (stream, crawlId) => stream.publish(crawlId, "crawl.completed", { counters }),
			},
			{
				type: "crawl.failed",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, "crawl.failed", { error: "failed", counters }),
			},
			{
				type: "crawl.stopped",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, "crawl.stopped", {
						stopReason: "stopped",
						counters,
					}),
			},
			{
				type: "crawl.paused",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, "crawl.paused", {
						stopReason: "paused",
						counters,
					}),
			},
		];

		const crawlId = "round-trip";
		const stream = new EventStream();
		stream.initialize(crawlId);
		for (const [index, event] of events.entries()) {
			const published = event.publish(stream, crawlId);
			const parsed = parseCrawlEventEnvelope(
				await readFirstPayload(await createResponse(stream, crawlId, index), event.type),
			);
			expect(parsed).toEqual(published);
		}
	});

	test("Elysia stream cancellation releases EventStream subscriber ownership", async () => {
		const stream = new EventStream();
		stream.initialize("cancel");
		stream.publish("cancel", "crawl.log", { message: "ready" });
		const response = await createResponse(stream, "cancel");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected SSE response body");
		await reader.read();
		await reader.cancel();

		const unsubscribers = Array.from({ length: 10 }, () => stream.subscribe("cancel", () => {}));
		for (const unsubscribe of unsubscribers) unsubscribe();
	});

	test("evicts a subscriber whose unread delivery queue reaches its bound", async () => {
		const stream = new EventStream();
		stream.initialize("slow-client");
		const response = await createResponse(stream, "slow-client");
		for (let index = 0; index < 40; index += 1) {
			stream.publish("slow-client", "crawl.log", { message: `event-${index}` });
		}
		await Promise.resolve();

		const unsubscribers = Array.from({ length: 10 }, () =>
			stream.subscribe("slow-client", () => {}),
		);
		for (const unsubscribe of unsubscribers) unsubscribe();
		await response.body?.cancel();
	});

	test("evicts a subscriber before one oversized event enters its delivery queue", async () => {
		const stream = new EventStream();
		stream.initialize("oversized-event");
		const response = await createResponse(stream, "oversized-event");
		stream.publish("oversized-event", "crawl.log", { message: "x".repeat(300_000) });
		await Promise.resolve();

		const unsubscribers = Array.from({ length: 10 }, () =>
			stream.subscribe("oversized-event", () => {}),
		);
		for (const unsubscribe of unsubscribers) unsubscribe();
		await response.body?.cancel();
	});

	test("replay overflow releases subscriber ownership before stream startup returns", async () => {
		const stream = new EventStream();
		stream.initialize("replay-overflow");
		for (let index = 0; index < 40; index += 1) {
			stream.publish("replay-overflow", "crawl.log", { message: `event-${index}` });
		}
		const setIntervalSpy = spyOn(globalThis, "setInterval");
		let response: Response | undefined;
		try {
			response = await createResponse(stream, "replay-overflow");
			expect(setIntervalSpy).not.toHaveBeenCalled();
			const unsubscribers = Array.from({ length: 10 }, () =>
				stream.subscribe("replay-overflow", () => {}),
			);
			for (const unsubscribe of unsubscribers) unsubscribe();
		} finally {
			await response?.body?.cancel();
			setIntervalSpy.mockRestore();
		}
	});
});
