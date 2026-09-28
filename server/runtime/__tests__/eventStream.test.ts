import { describe, expect, test } from "bun:test";
import { EventStream } from "../EventStream.js";

const logPayload = (message: string) => ({ message, level: "info" as const });

describe("event stream contract", () => {
	test("delivers only events published after subscription, with the publisher's sequence", () => {
		const stream = new EventStream();
		stream.publish("crawl-live", 1, "crawl.log", logPayload("before"));
		const seen: Array<{ sequence: number; message: string }> = [];
		stream.subscribe("crawl-live", (event) => {
			if (event.type === "crawl.log") {
				seen.push({ sequence: event.sequence, message: event.payload.message });
			}
		});

		const published = stream.publish("crawl-live", 2, "crawl.log", logPayload("after"));

		expect(published).toMatchObject({ crawlId: "crawl-live", sequence: 2, type: "crawl.log" });
		expect(seen).toEqual([{ sequence: 2, message: "after" }]);
	});

	test("isolates delivered events from later payload mutation", () => {
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
		const seen: Array<{ pagesScanned: number }> = [];
		stream.subscribe("crawl-immutable", (event) => {
			if (event.type === "crawl.progress") seen.push(event.payload.counters);
		});

		stream.publish("crawl-immutable", 1, "crawl.progress", {
			counters,
			queue: { activeRequests: 0, queueLength: 0, elapsedTime: 0, pagesPerSecond: 0 },
			stopReason: null,
		});
		counters.pagesScanned = 99;

		expect(seen.map((observed) => observed.pagesScanned)).toEqual([1]);
	});

	test("subscriber failures do not break publish or block other subscribers", () => {
		const stream = new EventStream();
		const seen: number[] = [];
		let failingClosed = false;
		stream.subscribe(
			"crawl-subscriber-failure",
			() => {
				throw new Error("subscriber failed");
			},
			() => {
				failingClosed = true;
			},
		);
		stream.subscribe("crawl-subscriber-failure", (event) => seen.push(event.sequence));

		expect(() =>
			stream.publish("crawl-subscriber-failure", 1, "crawl.log", logPayload("hello")),
		).not.toThrow();
		expect(seen).toEqual([1]);
		expect(failingClosed).toBe(true);
	});

	test("closeCrawl ends every subscription to that crawl only", () => {
		const stream = new EventStream();
		let closed = 0;
		for (let index = 0; index < 3; index += 1) {
			stream.subscribe(
				"crawl-settled",
				() => {},
				() => {
					closed += 1;
				},
			);
		}
		let otherClosed = false;
		stream.subscribe(
			"crawl-other",
			() => {},
			() => {
				otherClosed = true;
			},
		);

		stream.closeCrawl("crawl-settled");

		expect(closed).toBe(3);
		expect(otherClosed).toBe(false);
		expect(stream.hasSubscriberCapacity("crawl-settled")).toBe(true);
	});

	test("bounds subscriber admission per crawl", () => {
		const stream = new EventStream();
		for (let index = 0; index < 10; index += 1) {
			stream.subscribe("crawl-capacity", () => {});
		}

		expect(stream.hasSubscriberCapacity("crawl-capacity")).toBe(false);
		expect(() => stream.subscribe("crawl-capacity", () => {})).toThrow(
			"SSE subscriber capacity reached",
		);
	});

	test("prevents one client from monopolizing a crawl stream", () => {
		const stream = new EventStream();
		stream.subscribe("crawl-client-capacity", () => {}, undefined, "client-a");
		stream.subscribe("crawl-client-capacity", () => {}, undefined, "client-a");

		expect(stream.hasSubscriberCapacity("crawl-client-capacity", "client-a")).toBe(false);
		expect(stream.hasSubscriberCapacity("crawl-client-capacity", "client-b")).toBe(true);
	});

	test("unsubscribing releases per-client capacity", () => {
		const stream = new EventStream();
		const unsubscribe = stream.subscribe("crawl-release", () => {}, undefined, "client-a");
		stream.subscribe("crawl-release", () => {}, undefined, "client-a");

		unsubscribe();

		expect(stream.hasSubscriberCapacity("crawl-release", "client-a")).toBe(true);
	});

	test("closes every subscriber and refuses new ones during shutdown", async () => {
		const stream = new EventStream();
		let closed = 0;
		stream.subscribe(
			"crawl-shutdown",
			() => {},
			() => {
				closed += 1;
			},
		);

		stream.close();
		let lateClosed = false;
		stream.subscribe(
			"crawl-shutdown",
			() => {},
			() => {
				lateClosed = true;
			},
		);
		await Promise.resolve();

		expect(closed).toBe(1);
		expect(lateClosed).toBe(true);
		expect(stream.hasSubscriberCapacity("crawl-shutdown")).toBe(false);
	});
});
