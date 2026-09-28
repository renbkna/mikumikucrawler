import { describe, expect, mock, test } from "bun:test";
import type { CrawlOptions } from "../../../../shared/contracts/index.js";
import { CrawlQueue, type QueueItem } from "../CrawlQueue.js";
import { CrawlState } from "../CrawlState.js";

const options: CrawlOptions = {
	target: "https://example.com",
	crawlMethod: "links",
	crawlDepth: 2,
	crawlDelay: 200,
	maxPages: 10,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 1,
	retryLimit: 1,
	dynamic: false,
	respectRobots: false,
	contentOnly: false,
	saveMedia: false,
};

describe("CrawlQueue", () => {
	test("queue ownership isolates restored records and publishes immutable work to adapters and workers", () => {
		const saved: QueueItem[] = [];
		const queue = new CrawlQueue(options, new CrawlState(options), {
			enqueueMany: (items) => saved.push(...items),
			reschedule: (item) => {
				saved.push(item);
			},
			clear: () => {},
		});
		const restored = {
			url: "https://example.com/restored",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 0,
		};
		queue.restore([restored]);
		restored.url = "https://elsewhere.example/changed";
		restored.availableAt = 50_000;
		const active = queue.nextReady(100).item;
		expect(active?.url).toBe("https://example.com/restored");
		if (!active) throw new Error("Expected restored work");
		expect(Reflect.set(active, "url", restored.url)).toBe(false);
		queue.tryScheduleRetry(active, 0);
		queue.markDone(active);
		expect(queue.activeCount).toBe(0);
		queue.enqueueNormalized({
			url: "https://example.com/new",
			domain: "example.com",
			depth: 1,
			retries: 0,
		});
		for (const record of saved) {
			expect(Reflect.set(record, "url", restored.url)).toBe(false);
		}
		expect(queue.nextReady(Date.now() + 1000).item?.url).toBe("https://example.com/restored");
		expect(queue.nextReady(Date.now() + 2000).item?.url).toBe("https://example.com/new");
	});

	test("discard commits durable removal, closes admission, and retains active ownership", () => {
		const durableUrls = new Set<string>();
		let failClear = true;
		const queue = new CrawlQueue(options, new CrawlState(options), {
			enqueueMany: (items) => {
				for (const item of items) durableUrls.add(item.url);
			},
			reschedule: (item) => {
				durableUrls.add(item.url);
			},
			clear: () => {
				if (failClear) throw new Error("clear failed");
				durableUrls.clear();
			},
		});
		for (const name of ["active", "pending"]) {
			queue.enqueueNormalized({
				url: `https://example.com/${name}`,
				domain: "example.com",
				depth: 1,
				retries: 0,
				availableAt: 0,
			});
		}
		const active = queue.nextReady(100).item;
		if (!active) throw new Error("Expected active work");
		expect(() => queue.discard()).toThrow("clear failed");
		expect(queue.pendingCount).toBe(1);
		expect(durableUrls.size).toBe(2);
		expect(queue.tryScheduleRetry(active, 0)).toBe(true);
		failClear = false;
		queue.discard();
		expect(queue.pendingCount).toBe(0);
		expect(durableUrls.size).toBe(0);
		expect(queue.activeCount).toBe(1);
		expect(queue.tryScheduleRetry(active, 0)).toBe(false);
		const lateItem = {
			url: "https://example.com/late",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 0,
		};
		expect(queue.enqueueNormalized(lateItem)).toBe(false);
		expect(() => queue.restore([lateItem])).toThrow("discarded queue");
		expect(queue.pendingCount).toBe(0);
		expect(durableUrls.size).toBe(0);
		queue.markDone(active);
		expect(queue.activeCount).toBe(0);
	});

	test("rejects restored depth and retry policy before exposing queued work", () => {
		for (const invalid of [
			{ depth: 3, retries: 0, message: "queued depth" },
			{ depth: 1, retries: 1, message: "queued retries" },
		]) {
			const state = new CrawlState({ ...options, crawlDepth: 2, retryLimit: 0 });
			const queue = new CrawlQueue({ ...options, retryLimit: 0 }, state, {
				enqueueMany: mock(() => undefined),
				reschedule: mock(() => undefined),
				clear: mock(() => undefined),
			});

			expect(() =>
				queue.restore([
					{
						url: "https://example.com/restored",
						domain: "example.com",
						depth: invalid.depth,
						retries: invalid.retries,
						availableAt: 0,
					},
				]),
			).toThrow(invalid.message);
			expect(queue.pendingCount).toBe(0);
		}
	});

	test("rejects restored external work outside full crawl mode", () => {
		const state = new CrawlState(options);
		const queue = new CrawlQueue(options, state, {
			enqueueMany: mock(() => undefined),
			reschedule: mock(() => undefined),
			clear: mock(() => undefined),
		});

		expect(() =>
			queue.restore([
				{
					url: "https://external.example/page",
					domain: "external.example",
					depth: 1,
					retries: 0,
					availableAt: 0,
				},
			]),
		).toThrow("outside full crawl mode");
		expect(queue.pendingCount).toBe(0);
	});

	test("durable enqueue succeeds before queue and admission state become visible", () => {
		const state = new CrawlState({ ...options, maxPagesPerDomain: 1 });
		const queue = new CrawlQueue(options, state, {
			enqueueMany: () => {
				throw new Error("queue persistence failed");
			},
			reschedule: mock(() => undefined),
			clear: mock(() => undefined),
		});

		expect(() =>
			queue.enqueueNormalized({
				url: "https://example.com/persistence-failure",
				domain: "example.com",
				depth: 1,
				retries: 0,
			}),
		).toThrow("queue persistence failed");
		expect(queue.pendingCount).toBe(0);
		expect(state.canAdmit("https://example.com/persistence-failure", "example.com")).toBe(true);
	});

	test("persists pending domain delay state for resume", () => {
		const reschedule = mock(() => undefined);
		const queue = new CrawlQueue(
			options,
			{
				hasVisited: () => false,
				canAdmit: () => true,
				recordAdmission: () => undefined,
				nextAllowedAtForDomain: (delayKey: string) => (delayKey === "example.com" ? 500 : 50),
			} as never,
			{
				enqueueMany: mock(() => undefined),
				reschedule,
				clear: mock(() => undefined),
			},
		);

		queue.enqueueNormalized({
			url: "https://example.com/a",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});
		queue.enqueueNormalized({
			url: "https://other.example/b",
			domain: "other.example",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});

		queue.deferPendingToDomainDelays();

		expect(reschedule).toHaveBeenCalledTimes(1);
		expect(reschedule).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/a",
				availableAt: 500,
			}),
		);
	});

	test("failed delay persistence cannot advance the in-memory projection", () => {
		const item = {
			url: "https://example.com/delay-write-failure",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 100,
		};
		const reschedule = mock(() => {
			throw new Error("delay persistence failed");
		});
		const queue = new CrawlQueue(
			options,
			{
				restoreQueueAdmissions: () => undefined,
				nextAllowedAtForDomain: () => 500,
			} as never,
			{
				enqueueMany: mock(() => undefined),
				reschedule,
				clear: mock(() => undefined),
			},
		);
		queue.restore([item]);

		expect(() => queue.deferPendingToDomainDelays()).toThrow("delay persistence failed");
		// A second attempt must still try to persist the unchanged pending deadline.
		expect(() => queue.deferPendingToDomainDelays()).toThrow("delay persistence failed");
		expect(reschedule).toHaveBeenCalledTimes(2);
	});

	test("uses one hostname delay lane across schemes and ports", () => {
		const timeUntilDomainReady = mock((delayKey: string) => (delayKey === "example.com" ? 300 : 0));
		const reserveDomain = mock(() => undefined);
		const queue = new CrawlQueue(
			options,
			{
				hasVisited: () => false,
				canAdmit: () => true,
				recordAdmission: () => undefined,
				timeUntilDomainReady,
				reserveDomain,
				nextAllowedAtForDomain: () => 300,
			} as never,
			{
				enqueueMany: mock(() => undefined),
				reschedule: mock(() => undefined),
				clear: mock(() => undefined),
			},
		);

		queue.enqueueNormalized({
			url: "http://example.com:8080/slow",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});
		queue.enqueueNormalized({
			url: "https://example.com/ready",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});

		const ready = queue.nextReady(100);

		expect(ready.item).toBeNull();
		expect(timeUntilDomainReady).toHaveBeenCalledWith("example.com", 100);
		expect(reserveDomain).not.toHaveBeenCalled();
	});

	test("only the current attempt can schedule one bounded retry or release active ownership", () => {
		const settings = { ...options, crawlDelay: 0 };
		const reschedule = mock(() => undefined);
		const queue = new CrawlQueue(settings, new CrawlState(settings), {
			enqueueMany: () => {},
			reschedule,
			clear: () => {},
		});
		const item = {
			url: "https://example.com/retry",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 0,
		};
		expect(() => queue.enqueueNormalized({ ...item, retries: 1 })).toThrow("without retries");
		expect(() => queue.tryScheduleRetry(item, 0)).toThrow("current active attempt");
		queue.enqueueNormalized(item);
		const active = queue.nextReady(0).item;
		if (!active) throw new Error("Expected active work");
		expect(() => queue.tryScheduleRetry({ ...active }, 0)).toThrow("current active attempt");
		for (const delay of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER]) {
			expect(() => queue.tryScheduleRetry(active, delay)).toThrow("Retry delay");
		}
		expect(reschedule).not.toHaveBeenCalled();
		expect(queue.pendingCount).toBe(0);
		expect(queue.tryScheduleRetry(active, 0)).toBe(true);
		expect(() => queue.tryScheduleRetry(active, 0)).toThrow("already scheduled");
		expect(queue.pendingCount).toBe(1);
		expect(reschedule).toHaveBeenCalledTimes(1);
		queue.markDone(active);
		const retry = queue.nextReady().item;
		if (!retry) throw new Error("Expected retried work");
		reschedule.mockClear();
		expect(() => queue.markDone(active)).toThrow("current active attempt");
		expect(() => queue.tryScheduleRetry(active, 0)).toThrow("current active attempt");
		expect(queue.activeCount).toBe(1);
		expect(queue.tryScheduleRetry(retry, 0)).toBe(false);
		expect(queue.pendingCount).toBe(0);
		expect(reschedule).not.toHaveBeenCalled();
		queue.markDone(retry);
		expect(queue.activeCount).toBe(0);
	});

	test("zero retry capacity rejects even the first retry without persisting work", () => {
		const settings = { ...options, retryLimit: 0, crawlDelay: 0 };
		const reschedule = mock(() => undefined);
		const queue = new CrawlQueue(settings, new CrawlState(settings), {
			enqueueMany: () => {},
			reschedule,
			clear: () => {},
		});
		queue.enqueueNormalized({
			url: "https://example.com/no-retries",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 0,
		});
		const active = queue.nextReady(0).item;
		if (!active) throw new Error("Expected active work");
		expect(queue.tryScheduleRetry(active, 0)).toBe(false);
		expect(queue.pendingCount).toBe(0);
		expect(queue.activeCount).toBe(1);
		expect(reschedule).not.toHaveBeenCalled();
	});

	test("keeps a rescheduled item pending for the completion owner", () => {
		const reschedule = mock(() => undefined);
		const queue = new CrawlQueue(
			options,
			{
				hasVisited: () => false,
				canAdmit: () => true,
				recordAdmission: () => undefined,
				timeUntilDomainReady: () => 0,
				reserveDomain: mock(() => undefined),
				nextAllowedAtForDomain: () => 0,
			} as never,
			{
				enqueueMany: mock(() => undefined),
				reschedule,
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

		queue.enqueueNormalized(item);
		const active = queue.nextReady().item;
		if (!active) throw new Error("Expected active work");
		expect(queue.tryScheduleRetry(active, 0)).toBe(true);
		queue.markDone(active);
		expect(reschedule).toHaveBeenCalledWith(expect.objectContaining({ retries: 1 }));

		const ready = queue.nextReady(Date.now() + 1);
		expect(ready.item?.retries).toBe(1);
		if (!ready.item) {
			throw new Error("Expected retried queue item");
		}

		queue.markDone(ready.item);
		expect(queue.activeCount).toBe(0);
	});

	test("failed retry persistence cannot expose an in-memory retry", () => {
		const queue = new CrawlQueue(
			{ ...options, crawlDelay: 0 },
			{
				hasVisited: () => false,
				canAdmit: () => true,
				recordAdmission: () => undefined,
				timeUntilDomainReady: () => 0,
				reserveDomain: mock(() => undefined),
				nextAllowedAtForDomain: () => 0,
			} as never,
			{
				enqueueMany: mock(() => undefined),
				reschedule: () => {
					throw new Error("retry persistence failed");
				},
				clear: mock(() => undefined),
			},
		);
		queue.enqueueNormalized({
			url: "https://example.com/retry-write-failure",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 0,
		});
		const active = queue.nextReady(Date.now()).item;
		if (!active) {
			throw new Error("Expected active queue item");
		}

		expect(() => queue.tryScheduleRetry(active, 0)).toThrow("retry persistence failed");
		queue.markDone(active);
		expect(queue.pendingCount).toBe(0);
		expect(queue.nextReady(Date.now()).item).toBeNull();
	});

	test("does not dispatch a retried URL while the original item is active", () => {
		const queue = new CrawlQueue(
			{ ...options, maxConcurrentRequests: 2, crawlDelay: 0 },
			{
				hasVisited: () => false,
				canAdmit: () => true,
				recordAdmission: () => undefined,
				timeUntilDomainReady: () => 0,
				reserveDomain: mock(() => undefined),
				nextAllowedAtForDomain: () => 0,
			} as never,
			{
				enqueueMany: mock(() => undefined),
				reschedule: mock(() => undefined),
				clear: mock(() => undefined),
			},
		);

		queue.enqueueNormalized({
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

		queue.tryScheduleRetry(active, 0);

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
				canAdmit: () => true,
				recordAdmission: () => undefined,
				timeUntilDomainReady: () => 0,
				reserveDomain: mock((_delayKey: string, now: number) => {
					nextAllowedAt = now + 1000;
				}),
				nextAllowedAtForDomain: () => nextAllowedAt,
			} as never,
			{
				enqueueMany: mock(() => undefined),
				reschedule,
				clear: mock(() => undefined),
			},
		);

		queue.enqueueNormalized({
			url: "https://example.com/a",
			domain: "example.com",
			depth: 1,
			retries: 0,
			availableAt: 100,
		});
		queue.enqueueNormalized({
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
