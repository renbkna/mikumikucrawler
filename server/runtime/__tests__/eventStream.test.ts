import { describe, expect, test } from "bun:test";
import { EventStream } from "../EventStream.js";

describe("event stream contract", () => {
	test("emits monotonically increasing per-crawl sequence numbers", () => {
		const stream = new EventStream();
		const first = stream.publish("crawl-1", "crawl.started", {
			target: "https://example.com",
			resume: false,
		});
		const second = stream.publish("crawl-1", "crawl.progress", {
			counters: {
				pagesScanned: 1,
				successCount: 1,
				failureCount: 0,
				skippedCount: 0,
				linksFound: 0,
				mediaFiles: 0,
				totalDataKb: 1,
			},
			queue: {
				activeRequests: 0,
				queueLength: 0,
				elapsedTime: 1,
				pagesPerSecond: 1,
			},
			elapsedSeconds: 1,
			pagesPerSecond: 1,
			stopReason: null,
		});
		const third = stream.publish("crawl-1", "crawl.completed", {
			counters: {
				pagesScanned: 1,
				successCount: 1,
				failureCount: 0,
				skippedCount: 0,
				linksFound: 0,
				mediaFiles: 0,
				totalDataKb: 1,
			},
		});

		expect([first.sequence, second.sequence, third.sequence]).toEqual([
			1, 2, 3,
		]);
	});

	test("replays ordered history to late subscribers", () => {
		const stream = new EventStream();
		stream.publish("crawl-2", "crawl.started", {
			target: "https://example.com",
			resume: true,
		});
		stream.publish("crawl-2", "crawl.progress", {
			counters: {
				pagesScanned: 0,
				successCount: 0,
				failureCount: 0,
				skippedCount: 0,
				linksFound: 0,
				mediaFiles: 0,
				totalDataKb: 0,
			},
			queue: {
				activeRequests: 0,
				queueLength: 1,
				elapsedTime: 0,
				pagesPerSecond: 0,
			},
			elapsedSeconds: 0,
			pagesPerSecond: 0,
			stopReason: null,
		});

		const seen: number[] = [];
		stream.subscribe("crawl-2", (event) => {
			seen.push(event.sequence);
		});

		expect(seen).toEqual([1, 2]);
	});

	test("reset clears stale replay history and continues after the supplied sequence", () => {
		const stream = new EventStream();
		stream.publish("crawl-reset", "crawl.paused", {
			stopReason: "Pause requested",
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

		stream.reset("crawl-reset", 12);
		const seenBeforeResume: number[] = [];
		stream.subscribe("crawl-reset", (event) => {
			seenBeforeResume.push(event.sequence);
		});

		const resumed = stream.publish("crawl-reset", "crawl.started", {
			target: "https://example.com",
			resume: true,
		});

		expect(seenBeforeResume).toEqual([13]);
		expect(resumed.sequence).toBe(13);
	});

	test("replay history is isolated from later payload mutation", () => {
		const stream = new EventStream();
		const counters = {
			pagesScanned: 1,
			successCount: 1,
			failureCount: 0,
			skippedCount: 0,
			linksFound: 0,
			mediaFiles: 0,
			totalDataKb: 1,
		};

		stream.publish("crawl-immutable", "crawl.progress", {
			counters,
			queue: {
				activeRequests: 0,
				queueLength: 0,
				elapsedTime: 0,
				pagesPerSecond: 0,
			},
			elapsedSeconds: 0,
			pagesPerSecond: 0,
			stopReason: null,
		});

		counters.pagesScanned = 99;

		const seen: number[] = [];
		stream.subscribe("crawl-immutable", (event) => {
			if (event.type === "crawl.progress") {
				seen.push(event.payload.counters.pagesScanned);
			}
		});

		expect(seen).toEqual([1]);
	});

	test("subscriber failures do not break publish or block other subscribers", () => {
		const stream = new EventStream();
		const seen: number[] = [];
		stream.subscribe("crawl-subscriber-failure", () => {
			throw new Error("subscriber failed");
		});
		stream.subscribe("crawl-subscriber-failure", (event) => {
			seen.push(event.sequence);
		});

		expect(() =>
			stream.publish("crawl-subscriber-failure", "crawl.log", {
				message: "hello",
			}),
		).not.toThrow();
		expect(seen).toEqual([1]);
	});

	test("cleans up inactive crawl history after the cleanup delay", async () => {
		const stream = new EventStream();
		stream.publish("crawl-cleanup", "crawl.log", { message: "hello" });
		stream.scheduleCleanup("crawl-cleanup", 5);
		await Bun.sleep(20);

		const seen: number[] = [];
		const unsubscribe = stream.subscribe("crawl-cleanup", (event) => {
			seen.push(event.sequence);
		});
		unsubscribe();

		expect(seen).toEqual([]);
	});

	test("late subscribers do not cancel inactive crawl cleanup", async () => {
		const stream = new EventStream();
		stream.publish("crawl-late-cleanup", "crawl.log", { message: "hello" });
		stream.scheduleCleanup("crawl-late-cleanup", 5);

		const unsubscribe = stream.subscribe("crawl-late-cleanup", () => {});
		unsubscribe();
		await Bun.sleep(20);

		const seen: number[] = [];
		stream.subscribe("crawl-late-cleanup", (event) => {
			seen.push(event.sequence);
		})();

		expect(seen).toEqual([]);
	});
});
