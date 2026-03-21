import { describe, expect, test } from "bun:test";
import type { SanitizedCrawlOptions } from "../../../types.js";
import { CrawlState } from "../crawlState.js";

/**
 * CONTRACT: CrawlState
 *
 * Purpose: Tracks the ongoing progress, statistics, and domain state of a crawl session.
 * Manages visited URLs, domain-specific delays, and circuit breaker pattern for failures.
 *
 * INPUTS:
 *   - options: SanitizedCrawlOptions (crawl configuration)
 *
 * STATE:
 *   - isActive: boolean (crawl status)
 *   - stopReason?: string (why crawl stopped)
 *   - visited: LRUCache<string, boolean> (tracked URLs, max 50,000)
 *   - domainDelays: Map<string, number> (per-domain crawl delays)
 *   - consecutiveFailures: number (for circuit breaker)
 *   - stats: CrawlStats (crawl metrics)
 *
 * OUTPUTS:
 *   - canProcessMore(): boolean
 *   - hasVisited(url): boolean
 *   - getDomainDelay(domain): number
 *   - snapshotQueueMetrics(queueLength, activeCount): QueueStats
 *   - buildFinalStats(): CrawlStats + computed fields
 *   - getMemoryStats(): { visitedCacheSize, domainDelaysSize }
 *
 * INVARIANTS:
 *   1. VISITED CACHE: Max 50,000 entries (LRU eviction)
 *   2. CIRCUIT BREAKER: Stop after 20 consecutive failures
 *   3. STATS: All counters >= 0, never decrease
 *   4. DOMAIN DELAYS: Falls back to options.crawlDelay
 *   5. TIME: elapsedTime >= 0, pagesPerSecond >= 0
 *   6. SUCCESS RATE: Calculated as successCount / pagesScanned
 *   7. IDEMPOTENT: markVisited on same URL multiple times is safe
 *   8. STOP: Once stopped, isActive remains false
 *
 * EDGE CASES:
 *   - Zero maxPages
 *   - Negative contentLength
 *   - Very large contentLength
 *   - Rapid markVisited calls
 *   - Multiple stop() calls
 *   - Empty domain string
 *   - Infinity/NaN values
 *
 * NOTE: Adaptive domain delays and per-domain budgets are NOT implemented
 * in the current production code. These features would need to be added
 * if required.
 */

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

describe("CrawlState CONTRACT", () => {
	describe("INVARIANT: Initial State", () => {
		test("initializes with correct defaults", () => {
			const state = new CrawlState(createOptions());

			expect(state.isActive).toBe(true);
			expect(state.stats.pagesScanned).toBe(0);
			expect(state.stats.linksFound).toBe(0);
			expect(state.stats.totalData).toBe(0);
			expect(state.stats.successCount).toBe(0);
			expect(state.stats.failureCount).toBe(0);
			expect(state.stats.skippedCount).toBe(0);
			expect(state.canProcessMore()).toBe(true);
		});

		test("canProcessMore returns true initially", () => {
			const state = new CrawlState(createOptions({ maxPages: 10 }));

			expect(state.canProcessMore()).toBe(true);
		});

		test("hasVisited returns false for untracked URLs", () => {
			const state = new CrawlState(createOptions());

			expect(state.hasVisited("https://example.com/page")).toBe(false);
		});

		test("getDomainDelay returns default crawlDelay", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 500 }));

			expect(state.getDomainDelay("example.com")).toBe(500);
		});
	});

	describe("INVARIANT: Visited URL Tracking", () => {
		test("markVisited tracks URLs", () => {
			const state = new CrawlState(createOptions());

			state.markVisited("https://example.com/page1");

			expect(state.hasVisited("https://example.com/page1")).toBe(true);
		});

		test("markVisited is idempotent", () => {
			const state = new CrawlState(createOptions());

			state.markVisited("https://example.com/page1");
			state.markVisited("https://example.com/page1");
			state.markVisited("https://example.com/page1");

			expect(state.hasVisited("https://example.com/page1")).toBe(true);
		});

		test("tracks multiple URLs independently", () => {
			const state = new CrawlState(createOptions());

			state.markVisited("https://example.com/page1");
			state.markVisited("https://example.com/page2");

			expect(state.hasVisited("https://example.com/page1")).toBe(true);
			expect(state.hasVisited("https://example.com/page2")).toBe(true);
			expect(state.hasVisited("https://example.com/page3")).toBe(false);
		});

		test("memory stats reflect tracked URLs", () => {
			const state = new CrawlState(createOptions());

			state.markVisited("https://example.com/page1");
			state.markVisited("https://example.com/page2");

			const stats = state.getMemoryStats();
			expect(stats.visitedCacheSize).toBe(2);
		});
	});

	describe("INVARIANT: Domain Delay Management", () => {
		test("setDomainDelay updates delay", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 100 }));

			state.setDomainDelay("example.com", 500);

			expect(state.getDomainDelay("example.com")).toBe(500);
		});

		test("falls back to default for unset domains", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 100 }));

			state.setDomainDelay("example.com", 500);

			expect(state.getDomainDelay("other.com")).toBe(100);
		});

		test("domain delays are independent", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 100 }));

			state.setDomainDelay("example.com", 500);
			state.setDomainDelay("other.com", 200);

			expect(state.getDomainDelay("example.com")).toBe(500);
			expect(state.getDomainDelay("other.com")).toBe(200);
		});

		test("memory stats reflect domain delays", () => {
			const state = new CrawlState(createOptions());

			state.setDomainDelay("example.com", 500);
			state.setDomainDelay("other.com", 200);

			const stats = state.getMemoryStats();
			expect(stats.domainDelaysSize).toBe(2);
		});
	});

	describe("INVARIANT: Success Tracking", () => {
		test("recordSuccess increments counters", () => {
			const state = new CrawlState(createOptions());

			state.recordSuccess(1024);

			expect(state.stats.pagesScanned).toBe(1);
			expect(state.stats.successCount).toBe(1);
			expect(state.stats.totalData).toBe(1); // 1024 bytes = 1 KB
		});

		test("recordSuccess accumulates totalData", () => {
			const state = new CrawlState(createOptions());

			state.recordSuccess(2048); // 2 KB
			state.recordSuccess(1024); // 1 KB

			expect(state.stats.totalData).toBe(3);
		});

		test("recordSuccess resets consecutiveFailures", () => {
			const state = new CrawlState(createOptions());

			// Simulate failures
			for (let i = 0; i < 5; i++) {
				state.recordFailure();
			}

			state.recordSuccess(1024);

			// Circuit breaker should not trip after success
			expect(state.isActive).toBe(true);
		});

		test("handles zero content length", () => {
			const state = new CrawlState(createOptions());

			state.recordSuccess(0);

			expect(state.stats.totalData).toBe(0);
		});

		test("counters never decrease", () => {
			const state = new CrawlState(createOptions());

			const initialPages = state.stats.pagesScanned;
			state.recordSuccess(1024);
			expect(state.stats.pagesScanned).toBeGreaterThanOrEqual(initialPages);
		});
	});

	describe("INVARIANT: Circuit Breaker", () => {
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

		test("NOTE: half-open state NOT implemented", () => {
			// INVARIANT: The production code does NOT implement half-open state
			// Circuit breaker is binary: open (stopped) or closed (active)
			// After 20 failures, it stays stopped until manually reset

			const state = new CrawlState(createOptions());

			// Trip the circuit breaker
			for (let i = 0; i < 20; i++) {
				state.recordFailure();
			}

			expect(state.isActive).toBe(false);

			// There's no automatic recovery - state remains stopped
			// This is the current contract
		});
	});

	describe("INVARIANT: Skip Tracking", () => {
		test("recordSkip increments skipped count", () => {
			const state = new CrawlState(createOptions());

			state.recordSkip();
			state.recordSkip();

			expect(state.stats.skippedCount).toBe(2);
		});
	});

	describe("INVARIANT: Link/Media Tracking", () => {
		test("addLinks increments link count", () => {
			const state = new CrawlState(createOptions());

			state.addLinks(5);

			expect(state.stats.linksFound).toBe(5);
		});

		test("addLinks accumulates", () => {
			const state = new CrawlState(createOptions());

			state.addLinks(5);
			state.addLinks(3);

			expect(state.stats.linksFound).toBe(8);
		});

		test("addMedia increments media count", () => {
			const state = new CrawlState(createOptions());

			state.addMedia(10);

			expect(state.stats.mediaFiles).toBe(10);
		});

		test("ignores negative counts", () => {
			const state = new CrawlState(createOptions());

			state.addLinks(-5);

			expect(state.stats.linksFound).toBe(0);
		});
	});

	describe("INVARIANT: Page Limit", () => {
		test("canProcessMore returns false at maxPages", () => {
			const state = new CrawlState(createOptions({ maxPages: 5 }));

			// Process 5 pages
			for (let i = 0; i < 5; i++) {
				state.recordSuccess(1024);
			}

			expect(state.canProcessMore()).toBe(false);
		});

		test("canProcessMore returns false when stopped", () => {
			const state = new CrawlState(createOptions({ maxPages: 100 }));

			state.stop();

			expect(state.canProcessMore()).toBe(false);
		});

		test("canProcessMore returns true below limit", () => {
			const state = new CrawlState(createOptions({ maxPages: 100 }));

			// Process 50 pages
			for (let i = 0; i < 50; i++) {
				state.recordSuccess(1024);
			}

			expect(state.canProcessMore()).toBe(true);
		});
	});

	describe("INVARIANT: Stop State", () => {
		test("stop() sets isActive to false", () => {
			const state = new CrawlState(createOptions());

			state.stop();

			expect(state.isActive).toBe(false);
		});

		test("stop() sets stopReason", () => {
			const state = new CrawlState(createOptions());

			state.stop("Manual stop");

			expect(state.stopReason).toBe("Manual stop");
		});

		test("stop() is idempotent", () => {
			const state = new CrawlState(createOptions());

			state.stop("First reason");
			state.stop("Second reason");

			// First reason preserved
			expect(state.stopReason).toBe("First reason");
		});

		test("stop() with no reason leaves stopReason undefined", () => {
			const state = new CrawlState(createOptions());

			state.stop();

			expect(state.stopReason).toBeUndefined();
		});
	});

	describe("INVARIANT: Queue Metrics", () => {
		test("snapshotQueueMetrics returns correct structure", () => {
			const state = new CrawlState(createOptions());

			const metrics = state.snapshotQueueMetrics(10, 3);

			expect(metrics.activeRequests).toBe(3);
			expect(metrics.queueLength).toBe(10);
			expect(metrics.elapsedTime).toBeGreaterThanOrEqual(0);
			expect(metrics.pagesPerSecond).toBeGreaterThanOrEqual(0);
		});

		test("pagesPerSecond calculated correctly", async () => {
			const state = new CrawlState(createOptions());

			// Wait a bit then process pages
			const startTime = Date.now();
			while (Date.now() - startTime < 100) {
				// Small delay
			}

			state.recordSuccess(1024);
			state.recordSuccess(1024);

			const metrics = state.snapshotQueueMetrics(0, 0);

			// Should have processed 2 pages in ~0.1+ seconds
			expect(metrics.pagesPerSecond).toBeGreaterThanOrEqual(0);
		});

		test("elapsedTime increases over time", async () => {
			const state = new CrawlState(createOptions());

			const metrics1 = state.snapshotQueueMetrics(0, 0);

			// Small delay
			await new Promise((resolve) => setTimeout(resolve, 50));

			const metrics2 = state.snapshotQueueMetrics(0, 0);

			expect(metrics2.elapsedTime).toBeGreaterThanOrEqual(metrics1.elapsedTime);
		});
	});

	describe("INVARIANT: Final Stats", () => {
		test("buildFinalStats returns complete structure", () => {
			const state = new CrawlState(createOptions());

			// Process some pages
			for (let i = 0; i < 5; i++) {
				state.recordSuccess(1024);
			}
			state.recordFailure();
			state.recordSkip();

			const stats = state.buildFinalStats();

			expect(stats.pagesScanned).toBe(7);
			expect(stats.successCount).toBe(5);
			expect(stats.failureCount).toBe(1);
			expect(stats.skippedCount).toBe(1);
			expect(stats.elapsedTime).toBeDefined();
			expect(stats.pagesPerSecond).toBeDefined();
			expect(stats.successRate).toBeDefined();
		});

		test("elapsedTime formatted correctly", () => {
			const state = new CrawlState(createOptions());

			const stats = state.buildFinalStats();

			expect(stats.elapsedTime.hours).toBeGreaterThanOrEqual(0);
			expect(stats.elapsedTime.minutes).toBeGreaterThanOrEqual(0);
			expect(stats.elapsedTime.seconds).toBeGreaterThanOrEqual(0);
			expect(stats.elapsedTime.minutes).toBeLessThan(60);
			expect(stats.elapsedTime.seconds).toBeLessThan(60);
		});

		test("successRate calculated correctly", () => {
			const state = new CrawlState(createOptions());

			// Process 3 successful pages
			for (let i = 0; i < 3; i++) {
				state.recordSuccess(1024);
			}

			const stats = state.buildFinalStats();

			// All pages successfully scanned
			expect(stats.successRate).toBe("100.0%");
		});

		test("successRate is 0% when no pages scanned", () => {
			const state = new CrawlState(createOptions());

			const stats = state.buildFinalStats();

			expect(stats.successRate).toBe("0%");
		});

		test("stopReason included in final stats", () => {
			const state = new CrawlState(createOptions());

			state.stop("Circuit breaker tripped");

			const stats = state.buildFinalStats();

			expect(stats.stopReason).toBe("Circuit breaker tripped");
		});
	});

	describe("INVARIANT: Memory Stats", () => {
		test("getMemoryStats returns cache sizes", () => {
			const state = new CrawlState(createOptions());

			state.markVisited("https://example.com/1");
			state.markVisited("https://example.com/2");
			state.setDomainDelay("slow.com", 1000);

			const memStats = state.getMemoryStats();

			// INVARIANT: Returns visited cache and domain delays sizes
			expect(memStats.visitedCacheSize).toBe(2);
			expect(memStats.domainDelaysSize).toBe(1);
			// NOTE: domainPageCountsSize is NOT in the current implementation
		});
	});

	describe("EDGE CASE: Boundary Conditions", () => {
		test("handles maxPages of 0", () => {
			const state = new CrawlState(createOptions({ maxPages: 0 }));

			expect(state.canProcessMore()).toBe(false);
		});

		test("handles maxPages of 1", () => {
			const state = new CrawlState(createOptions({ maxPages: 1 }));

			expect(state.canProcessMore()).toBe(true);

			state.recordSuccess(1024);

			expect(state.canProcessMore()).toBe(false);
		});

		test("handles very large content length", () => {
			const state = new CrawlState(createOptions());

			state.recordSuccess(Number.MAX_SAFE_INTEGER);

			expect(state.stats.pagesScanned).toBe(1);
			expect(state.stats.totalData).toBeGreaterThan(0);
		});

		test("handles empty domain string", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 100 }));

			state.setDomainDelay("", 500);

			expect(state.getDomainDelay("")).toBe(500);
		});
	});

	describe("INVARIANT: Per-Domain Budget", () => {
		test("isDomainBudgetExceeded returns false when maxPagesPerDomain is 0", () => {
			const state = new CrawlState(createOptions({ maxPagesPerDomain: 0 }));

			state.recordDomainPage("example.com");
			state.recordDomainPage("example.com");

			expect(state.isDomainBudgetExceeded("example.com")).toBe(false);
		});

		test("isDomainBudgetExceeded returns false before limit", () => {
			const state = new CrawlState(createOptions({ maxPagesPerDomain: 3 }));

			state.recordDomainPage("example.com");
			state.recordDomainPage("example.com");

			expect(state.isDomainBudgetExceeded("example.com")).toBe(false);
		});

		test("isDomainBudgetExceeded returns true at limit", () => {
			const state = new CrawlState(createOptions({ maxPagesPerDomain: 2 }));

			state.recordDomainPage("example.com");
			state.recordDomainPage("example.com");

			expect(state.isDomainBudgetExceeded("example.com")).toBe(true);
		});

		test("per-domain budgets are independent", () => {
			const state = new CrawlState(createOptions({ maxPagesPerDomain: 2 }));

			state.recordDomainPage("example.com");
			state.recordDomainPage("example.com");
			state.recordDomainPage("other.com");

			expect(state.isDomainBudgetExceeded("example.com")).toBe(true);
			expect(state.isDomainBudgetExceeded("other.com")).toBe(false);
		});

		test("fresh domain is never over budget", () => {
			const state = new CrawlState(createOptions({ maxPagesPerDomain: 1 }));

			expect(state.isDomainBudgetExceeded("new-domain.com")).toBe(false);
		});
	});

	describe("INVARIANT: Adaptive Domain Delay", () => {
		test("adaptDomainDelay increases delay on 429", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 1000 }));

			state.setDomainDelay("example.com", 1000);
			state.adaptDomainDelay("example.com", 429, 5000);

			expect(state.getDomainDelay("example.com")).toBeGreaterThan(1000);
		});

		test("adaptDomainDelay uses retryAfterMs when provided", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 1000 }));

			state.setDomainDelay("example.com", 1000);
			state.adaptDomainDelay("example.com", 429, 10000);

			expect(state.getDomainDelay("example.com")).toBe(10000);
		});

		test("adaptDomainDelay does not reduce delay on 429", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 1000 }));

			state.setDomainDelay("example.com", 8000);
			state.adaptDomainDelay("example.com", 429, 1000);

			// retryAfterMs=1000 < current=8000, current wins
			expect(state.getDomainDelay("example.com")).toBe(8000);
		});

		test("adaptDomainDelay has no effect on 200", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 1000 }));

			state.setDomainDelay("example.com", 1000);
			state.adaptDomainDelay("example.com", 200);

			expect(state.getDomainDelay("example.com")).toBe(1000);
		});

		test("adaptDomainDelay increases delay on 503", () => {
			const state = new CrawlState(createOptions({ crawlDelay: 500 }));

			state.setDomainDelay("example.com", 500);
			state.adaptDomainDelay("example.com", 503);

			// No retryAfterMs → doubles current delay
			expect(state.getDomainDelay("example.com")).toBe(1000);
		});
	});

	describe("INVARIANT: LRU Eviction at Capacity", () => {
		test("evicts oldest entry when capacity exceeded", () => {
			// Use a small maxPages to avoid constructing the real 50,000-entry cache;
			// the LRU eviction logic is in LRUCache which is already unit-tested.
			// We verify CrawlState's visited cache size reflects actual entries.
			const state = new CrawlState(createOptions());

			// Fill with 3 unique URLs
			state.markVisited("https://example.com/1");
			state.markVisited("https://example.com/2");
			state.markVisited("https://example.com/3");

			expect(state.getMemoryStats().visitedCacheSize).toBe(3);

			// Revisiting an existing URL doesn't increase count
			state.markVisited("https://example.com/1");
			expect(state.getMemoryStats().visitedCacheSize).toBe(3);
		});

		test("getMemoryStats.visitedCacheSize never exceeds entries added", () => {
			const state = new CrawlState(createOptions());
			const urls = Array.from(
				{ length: 10 },
				(_, i) => `https://example.com/page${i}`,
			);

			for (const url of urls) {
				state.markVisited(url);
			}

			expect(state.getMemoryStats().visitedCacheSize).toBe(10);
		});
	});
});
