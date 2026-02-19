import { describe, expect, test } from "bun:test";
import type { SanitizedCrawlOptions } from "../../../types.js";
import { CrawlState } from "../crawlState.js";

const createOptions = (
	overrides: Partial<SanitizedCrawlOptions> = {},
): SanitizedCrawlOptions => ({
	target: "https://example.com",
	crawlDepth: 2,
	maxPages: 100,
	maxPagesPerDomain: 0,
	crawlDelay: 100,
	crawlMethod: "full",
	maxConcurrentRequests: 5,
	retryLimit: 3,
	dynamic: false,
	respectRobots: true,
	contentOnly: false,
	saveMedia: false,
	...overrides,
});

describe("CrawlState", () => {
	describe("basic state management", () => {
		test("initializes with correct default values", () => {
			const state = new CrawlState(createOptions());

			expect(state.isActive).toBe(true);
			expect(state.stats.pagesScanned).toBe(0);
			expect(state.stats.linksFound).toBe(0);
			expect(state.stats.totalData).toBe(0);
			expect(state.canProcessMore()).toBe(true);
		});

		test("tracks visited URLs", () => {
			const state = new CrawlState(createOptions());

			expect(state.hasVisited("https://example.com")).toBe(false);
			state.markVisited("https://example.com");
			expect(state.hasVisited("https://example.com")).toBe(true);
		});

		test("stops accepting new URLs after stop() is called", () => {
			const state = new CrawlState(createOptions());

			expect(state.isActive).toBe(true);
			state.stop("user requested");
			expect(state.isActive).toBe(false);
			expect(state.stopReason).toBe("user requested");
		});

		test("respects maxPages limit", () => {
			const state = new CrawlState(createOptions({ maxPages: 2 }));

			expect(state.canProcessMore()).toBe(true);
			state.recordSuccess(1000);
			expect(state.canProcessMore()).toBe(true);
			state.recordSuccess(1000);
			expect(state.canProcessMore()).toBe(false);
		});
	});

	describe("statistics tracking", () => {
		test("recordSuccess increments counters and resets consecutive failures", () => {
			const state = new CrawlState(createOptions());

			state.recordFailure();
			state.recordFailure();
			state.recordSuccess(5000);

			expect(state.stats.pagesScanned).toBe(1);
			expect(state.stats.successCount).toBe(1);
			expect(state.stats.totalData).toBe(4); // 5000 / 1024 = 4
		});

		test("recordFailure increments failure count", () => {
			const state = new CrawlState(createOptions());

			state.recordFailure();
			state.recordFailure();

			expect(state.stats.failureCount).toBe(2);
		});

		test("recordSkip increments skipped count", () => {
			const state = new CrawlState(createOptions());

			state.recordSkip();
			state.recordSkip();

			expect(state.stats.skippedCount).toBe(2);
		});

		test("addLinks and addMedia track counts", () => {
			const state = new CrawlState(createOptions());

			state.addLinks(10);
			state.addLinks(5);
			state.addMedia(3);

			expect(state.stats.linksFound).toBe(15);
			expect(state.stats.mediaFiles).toBe(3);
		});
	});

	describe("circuit breaker", () => {
		test("does not trip before threshold", () => {
			const state = new CrawlState(createOptions());

			for (let i = 0; i < 19; i++) {
				state.recordFailure();
			}

			expect(state.isActive).toBe(true);
		});

		test("trips after 20 consecutive failures", () => {
			const state = new CrawlState(createOptions());

			for (let i = 0; i < 20; i++) {
				state.recordFailure();
			}

			expect(state.isActive).toBe(false);
			expect(state.stopReason).toContain("Circuit breaker tripped");
		});

		test("resets consecutive failures on success", () => {
			const state = new CrawlState(createOptions());

			for (let i = 0; i < 15; i++) {
				state.recordFailure();
			}

			state.recordSuccess(1000);

			for (let i = 0; i < 10; i++) {
				state.recordFailure();
			}

			expect(state.isActive).toBe(true);
		});

		test("half-open state allows retry after cooldown", () => {
			const state = new CrawlState(createOptions());

			for (let i = 0; i < 20; i++) {
				state.recordFailure();
			}

			expect(state.isActive).toBe(false);

			// Simulate cooldown period passing by manipulating private field
			// The cooldown is 60 seconds, so we set lastFailureTime to 61 seconds ago
			(state as unknown as { lastFailureTime: number }).lastFailureTime =
				Date.now() - 61000;

			// Now record another failure - the cooldown should reset counters
			// and NOT trip the circuit breaker (allows retry in half-open state)
			state.recordFailure();

			// After reset, consecutiveFailures should be 1 (just this one failure)
			// and circuit should NOT be tripped yet
			expect(state.isActive).toBe(true);
			expect(
				(state as unknown as { consecutiveFailures: number })
					.consecutiveFailures,
			).toBe(1);
		});
	});

	describe("domain delays", () => {
		test("returns default delay when no domain-specific delay set", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 500 }));

			expect(state.getDomainDelay("example.com")).toBe(500);
		});

		test("stores and retrieves domain-specific delays", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 100 }));

			state.setDomainDelay("slow-site.com", 2000);

			expect(state.getDomainDelay("slow-site.com")).toBe(2000);
			expect(state.getDomainDelay("other-site.com")).toBe(100);
		});

		test("adapts delay on rate limit (429)", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 100 }));

			state.adaptDomainDelay("rate-limited.com", 1000, 429);

			expect(state.getDomainDelay("rate-limited.com")).toBe(300);
		});

		test("adapts delay on service unavailable (503)", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 100 }));

			state.adaptDomainDelay("overloaded.com", 1000, 503);

			expect(state.getDomainDelay("overloaded.com")).toBe(300);
		});

		test("respects Retry-After header on rate limit", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 100 }));

			state.adaptDomainDelay("strict.com", 1000, 429, 5000);

			expect(state.getDomainDelay("strict.com")).toBe(5000);
		});

		test("increases delay on slow responses", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 100 }));

			state.adaptDomainDelay("slow.com", 5000, 200);

			expect(state.getDomainDelay("slow.com")).toBeGreaterThan(100);
		});

		test("decreases delay on fast responses (but not below floor)", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 100 }));

			state.setDomainDelay("fast.com", 1000);
			state.adaptDomainDelay("fast.com", 50, 200);

			expect(state.getDomainDelay("fast.com")).toBeLessThan(1000);
			expect(state.getDomainDelay("fast.com")).toBeGreaterThanOrEqual(100);
		});
	});

	describe("per-domain budget", () => {
		test("returns false when budget is 0 (unlimited)", () => {
			const state = new CrawlState(createOptions({ maxPagesPerDomain: 0 }));

			state.recordDomainPage("example.com");
			state.recordDomainPage("example.com");
			state.recordDomainPage("example.com");

			expect(state.isDomainBudgetExceeded("example.com")).toBe(false);
		});

		test("enforces per-domain page limit", () => {
			const state = new CrawlState(createOptions({ maxPagesPerDomain: 2 }));

			expect(state.isDomainBudgetExceeded("example.com")).toBe(false);

			state.recordDomainPage("example.com");
			expect(state.isDomainBudgetExceeded("example.com")).toBe(false);

			state.recordDomainPage("example.com");
			expect(state.isDomainBudgetExceeded("example.com")).toBe(true);
		});

		test("tracks budgets independently per domain", () => {
			const state = new CrawlState(createOptions({ maxPagesPerDomain: 2 }));

			state.recordDomainPage("site-a.com");
			state.recordDomainPage("site-a.com");
			state.recordDomainPage("site-b.com");

			expect(state.isDomainBudgetExceeded("site-a.com")).toBe(true);
			expect(state.isDomainBudgetExceeded("site-b.com")).toBe(false);
		});
	});

	describe("memory stats", () => {
		test("returns memory usage information", () => {
			const state = new CrawlState(createOptions());

			state.markVisited("https://example.com/1");
			state.markVisited("https://example.com/2");
			state.setDomainDelay("slow.com", 1000);

			const memStats = state.getMemoryStats();

			expect(memStats.visitedCacheSize).toBe(2);
			expect(memStats.domainDelaysSize).toBe(1);
			expect(memStats.domainPageCountsSize).toBe(0);
		});
	});

	describe("queue metrics snapshot", () => {
		test("calculates pages per second", async () => {
			const state = new CrawlState(createOptions());

			await new Promise((resolve) => setTimeout(resolve, 100));

			state.recordSuccess(1000);
			state.recordSuccess(1000);

			const snapshot = state.snapshotQueueMetrics(10, 2);

			expect(snapshot.queueLength).toBe(10);
			expect(snapshot.activeRequests).toBe(2);
			expect(snapshot.elapsedTime).toBeGreaterThanOrEqual(0);
		});
	});

	describe("final stats", () => {
		test("builds comprehensive final statistics", () => {
			const state = new CrawlState(createOptions());

			state.recordSuccess(5000);
			state.recordSuccess(3000);
			state.recordFailure();
			state.addLinks(20);
			state.stop("completed");

			const finalStats = state.buildFinalStats();

			expect(finalStats.pagesScanned).toBe(2);
			expect(finalStats.successCount).toBe(2);
			expect(finalStats.failureCount).toBe(1);
			expect(finalStats.linksFound).toBe(20);
			expect(finalStats.stopReason).toBe("completed");
			expect(finalStats.successRate).toBe("100.0%");
			expect(finalStats.elapsedTime).toBeDefined();
		});
	});
});
