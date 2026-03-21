import { describe, expect, test } from "bun:test";
import { EventStream } from "../EventStream.js";

describe("event stream contract", () => {
	test("emits monotonically increasing per-crawl sequence numbers", () => {
		const stream = new EventStream();
		const first = stream.publish("crawl-1", "crawl.started", { ok: true });
		const second = stream.publish("crawl-1", "crawl.progress", { ok: true });
		const third = stream.publish("crawl-1", "crawl.completed", { ok: true });

		expect([first.sequence, second.sequence, third.sequence]).toEqual([
			1, 2, 3,
		]);
	});

	test("replays ordered history to late subscribers", () => {
		const stream = new EventStream();
		stream.publish("crawl-2", "crawl.started", { step: 1 });
		stream.publish("crawl-2", "crawl.progress", { step: 2 });

		const seen: number[] = [];
		stream.subscribe("crawl-2", (event) => {
			seen.push(event.sequence);
		});

		expect(seen).toEqual([1, 2]);
	});
});
