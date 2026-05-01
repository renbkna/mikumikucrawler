import { describe, expect, mock, test } from "bun:test";
import type { CrawlOptions } from "../../../../shared/contracts/crawl.js";
import type { Logger } from "../../../config/logging.js";
import { CrawlQueue } from "../CrawlQueue.js";

const options: CrawlOptions = {
	target: "https://example.com",
	crawlMethod: "links",
	crawlDepth: 2,
	crawlDelay: 200,
	maxPages: 10,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 1,
	retryLimit: 0,
	dynamic: false,
	respectRobots: false,
	contentOnly: false,
	saveMedia: false,
};

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

describe("CrawlQueue", () => {
	test("persists pending domain delay state for resume", () => {
		const reschedule = mock(() => undefined);
		const queue = new CrawlQueue(
			options,
			{
				hasVisited: () => false,
				tryAdmit: () => true,
			} as never,
			createLogger(),
			{
				enqueueMany: mock(() => undefined),
				reschedule,
				remove: mock(() => undefined),
				clear: mock(() => undefined),
			},
		);

		queue.enqueue({
			url: "https://example.com/a",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});
		queue.enqueue({
			url: "https://other.example/b",
			domain: "other.example",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});

		queue.deferPendingByDelayKey((delayKey) =>
			delayKey === "https://example.com" ? 500 : 50,
		);

		expect(reschedule).toHaveBeenCalledTimes(1);
		expect(reschedule).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/a",
				availableAt: 500,
			}),
		);
	});

	test("uses origin delay keys for scheduling while preserving host budget domains", () => {
		const timeUntilDomainReady = mock((delayKey: string, now: number) =>
			delayKey === "http://example.com:8080" ? 300 : 0,
		);
		const reserveDomain = mock(() => undefined);
		const queue = new CrawlQueue(
			options,
			{
				hasVisited: () => false,
				tryAdmit: () => true,
				timeUntilDomainReady,
				reserveDomain,
				nextAllowedAtForDomain: () => 300,
			} as never,
			createLogger(),
			{
				enqueueMany: mock(() => undefined),
				reschedule: mock(() => undefined),
				remove: mock(() => undefined),
				clear: mock(() => undefined),
			},
		);

		queue.enqueue({
			url: "http://example.com:8080/slow",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});
		queue.enqueue({
			url: "https://example.com/ready",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});

		const ready = queue.nextReady(100);

		expect(ready.item?.url).toBe("https://example.com/ready");
		expect(timeUntilDomainReady).toHaveBeenCalledWith(
			"http://example.com:8080",
			100,
		);
		expect(reserveDomain).toHaveBeenCalledWith("https://example.com", 100);
	});

	test("preserves retry persistence until the retried item reaches a terminal outcome", () => {
		const remove = mock(() => undefined);
		const queue = new CrawlQueue(
			options,
			{
				hasVisited: () => false,
				tryAdmit: () => true,
				timeUntilDomainReady: () => 0,
				reserveDomain: mock(() => undefined),
				nextAllowedAtForDomain: () => 0,
			} as never,
			createLogger(),
			{
				enqueueMany: mock(() => undefined),
				reschedule: mock(() => undefined),
				remove,
				clear: mock(() => undefined),
			},
		);
		const item = {
			url: "https://example.com/rate",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 0,
		};

		queue.scheduleRetry(item, 0);
		queue.markDone(item);
		expect(remove).not.toHaveBeenCalled();

		const ready = queue.nextReady(Date.now() + 1);
		expect(ready.item?.retries).toBe(1);
		if (!ready.item) {
			throw new Error("Expected retried queue item");
		}

		queue.markDone(ready.item, { persist: false });
		expect(remove).not.toHaveBeenCalled();

		queue.markDone(ready.item);
		expect(remove).toHaveBeenCalledWith("https://example.com/rate");
	});

	test("does not dispatch a retried URL while the original item is active", () => {
		const queue = new CrawlQueue(
			{ ...options, maxConcurrentRequests: 2, crawlDelay: 0 },
			{
				hasVisited: () => false,
				tryAdmit: () => true,
				timeUntilDomainReady: () => 0,
				reserveDomain: mock(() => undefined),
				nextAllowedAtForDomain: () => 0,
			} as never,
			createLogger(),
			{
				enqueueMany: mock(() => undefined),
				reschedule: mock(() => undefined),
				remove: mock(() => undefined),
				clear: mock(() => undefined),
			},
		);

		queue.enqueue({
			url: "https://example.com/rate",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 0,
		});
		const active = queue.nextReady(Date.now()).item;
		if (!active) {
			throw new Error("Expected active queue item");
		}

		queue.scheduleRetry(active, 0);

		expect(queue.nextReady(Date.now() + 1).item).toBeNull();
		expect(queue.activeCount).toBe(1);

		queue.markDone(active);
		expect(queue.nextReady(Date.now() + 1).item).toEqual(
			expect.objectContaining({
				url: "https://example.com/rate",
				retries: 1,
			}),
		);
	});

	test("persists dispatch delay watermarks for active and pending same-domain work", () => {
		let nextAllowedAt = 0;
		const reschedule = mock(() => undefined);
		const queue = new CrawlQueue(
			{ ...options, crawlDelay: 1000 },
			{
				hasVisited: () => false,
				tryAdmit: () => true,
				timeUntilDomainReady: () => 0,
				reserveDomain: mock((_delayKey: string, now: number) => {
					nextAllowedAt = now + 1000;
				}),
				nextAllowedAtForDomain: () => nextAllowedAt,
			} as never,
			createLogger(),
			{
				enqueueMany: mock(() => undefined),
				reschedule,
				remove: mock(() => undefined),
				clear: mock(() => undefined),
			},
		);

		queue.enqueue({
			url: "https://example.com/a",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});
		queue.enqueue({
			url: "https://example.com/b",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});

		const ready = queue.nextReady(100);

		expect(ready.item?.url).toBe("https://example.com/a");
		expect(reschedule).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/a",
				availableAt: 1100,
			}),
		);
		expect(reschedule).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/b",
				availableAt: 1100,
			}),
		);
	});
});
