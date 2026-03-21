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
});
