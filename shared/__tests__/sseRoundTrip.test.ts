import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createCrawlEventStream } from "../../server/plugins/sse.js";
import { EventStream } from "../../server/runtime/EventStream.js";
import type { CrawlEventEnvelope, CrawlEventType } from "../contracts/events.js";
import { parseCrawlEventEnvelope } from "../contracts/validation.js";

describe("SSE boundary", () => {
	function createResponse(stream: EventStream, crawlId: string) {
		const app = new Elysia().get("/events", () =>
			createCrawlEventStream({ crawlId, eventStream: stream }),
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
			let wire = "";
			while (!wire.includes("data: ")) {
				const { value, done } = await reader.read();
				expect(done).toBe(false);
				wire +=
					typeof value === "string"
						? value
						: value instanceof Uint8Array
							? new TextDecoder().decode(value)
							: "";
			}
			// Frames carry no SSE id: reconnecting clients recover from the snapshot.
			expect(wire).not.toContain("id: ");
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
					stream.publish(crawlId, 1, "crawl.started", {
						target: "https://example.com/",
						resume: false,
						dynamicRendering: false,
					}),
			},
			{
				type: "crawl.progress",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, 1, "crawl.progress", {
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
					stream.publish(crawlId, 1, "crawl.page", {
						id: 1,
						pageCount: 1,
						url: "https://example.com/",
						details: {},
					}),
			},
			{
				type: "crawl.log",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, 1, "crawl.log", { message: "ready", level: "info" }),
			},
			{
				type: "crawl.completed",
				publish: (stream, crawlId) => stream.publish(crawlId, 1, "crawl.completed", { counters }),
			},
			{
				type: "crawl.failed",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, 1, "crawl.failed", { error: "failed", counters }),
			},
			{
				type: "crawl.stopped",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, 1, "crawl.stopped", {
						stopReason: "stopped",
						counters,
					}),
			},
			{
				type: "crawl.paused",
				publish: (stream, crawlId) =>
					stream.publish(crawlId, 1, "crawl.paused", {
						stopReason: "paused",
						counters,
					}),
			},
		];

		const crawlId = "round-trip";
		const stream = new EventStream();
		for (const event of events) {
			const response = await createResponse(stream, crawlId);
			const published = event.publish(stream, crawlId);
			const parsed = parseCrawlEventEnvelope(await readFirstPayload(response, event.type));
			expect(parsed).toEqual(published);
		}
	});

	test("delivers a settled event before closing, even beyond the pending-event bound", async () => {
		const stream = new EventStream();
		const crawlId = "settled-live";
		const response = await createResponse(stream, crawlId);
		stream.publish(crawlId, 1, "crawl.log", { message: "before settlement", level: "info" });
		stream.publish(crawlId, 2, "crawl.failed", {
			error: `failed-${"x".repeat(300_000)}`,
			counters: {
				pagesScanned: 0,
				successCount: 0,
				failureCount: 0,
				skippedCount: 0,
				linksFound: 0,
				mediaFiles: 0,
				totalDataKb: 0,
			},
		});

		const wire = await response.text();

		expect(wire).toContain("event: crawl.log");
		expect(wire).toContain("event: crawl.failed");
		expect(wire).toContain("failed-xxx");
		expect(stream.hasSubscriberCapacity(crawlId)).toBe(true);
		const unsubscribers = Array.from({ length: 10 }, () => stream.subscribe(crawlId, () => {}));
		for (const unsubscribe of unsubscribers) unsubscribe();
	});

	test("Elysia stream cancellation releases EventStream subscriber ownership", async () => {
		const stream = new EventStream();
		const response = await createResponse(stream, "cancel");
		stream.publish("cancel", 1, "crawl.log", { message: "ready", level: "info" });
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected SSE response body");
		await reader.read();
		await reader.cancel();

		const unsubscribers = Array.from({ length: 10 }, () => stream.subscribe("cancel", () => {}));
		for (const unsubscribe of unsubscribers) unsubscribe();
	});

	test("evicts a subscriber whose unread delivery queue reaches its bound", async () => {
		const stream = new EventStream();
		const response = await createResponse(stream, "slow-client");
		for (let index = 0; index < 40; index += 1) {
			stream.publish("slow-client", index + 1, "crawl.log", {
				message: `event-${index}`,
				level: "info",
			});
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
		const response = await createResponse(stream, "oversized-event");
		stream.publish("oversized-event", 1, "crawl.log", {
			message: "x".repeat(300_000),
			level: "info",
		});
		await Promise.resolve();

		const unsubscribers = Array.from({ length: 10 }, () =>
			stream.subscribe("oversized-event", () => {}),
		);
		for (const unsubscribe of unsubscribers) unsubscribe();
		await response.body?.cancel();
	});
});
