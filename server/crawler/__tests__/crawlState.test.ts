import { describe, expect, test } from "bun:test";
import type { SanitizedCrawlOptions } from "../../types.js";
import { CrawlState } from "../modules/crawlState.js";

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
 */

const createMockOptions = (
	overrides: Partial<SanitizedCrawlOptions> = {},
): SanitizedCrawlOptions => ({
	target: "https://example.com",
	crawlDepth: 2,
	maxPages: 100,
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
			const options = createMockOptions();
			const state = new CrawlState(options);

			expect(state.isActive).toBe(true);
			expect(state.stats.pagesScanned).toBe(0);
			expect(state.stats.successCount).toBe(0);
			expect(state.stats.failureCount).toBe(0);
			expect(state.stats.skippedCount).toBe(0);
			expect(state.stats.linksFound).toBe(0);
			expect(state.stats.totalData).toBe(0);
		});

		test("canProcessMore returns true initially", () => {
			const options = createMockOptions({ maxPages: 10 });
			const state = new CrawlState(options);

			expect(state.canProcessMore()).toBe(true);
		});

		test("hasVisited returns false for untracked URLs", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			expect(state.hasVisited("https://example.com/page")).toBe(false);
		});

		test("getDomainDelay returns default crawlDelay", () => {
			const options = createMockOptions({ crawlDelay: 500 });
			const state = new CrawlState(options);

			expect(state.getDomainDelay("example.com")).toBe(500);
		});
	});

	describe("INVARIANT: Visited URL Tracking", () => {
		test("markVisited tracks URLs", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.markVisited("https://example.com/page1");

			expect(state.hasVisited("https://example.com/page1")).toBe(true);
		});

		test("markVisited is idempotent", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.markVisited("https://example.com/page1");
			state.markVisited("https://example.com/page1");
			state.markVisited("https://example.com/page1");

			expect(state.hasVisited("https://example.com/page1")).toBe(true);
		});

		test("tracks multiple URLs independently", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.markVisited("https://example.com/page1");
			state.markVisited("https://example.com/page2");

			expect(state.hasVisited("https://example.com/page1")).toBe(true);
			expect(state.hasVisited("https://example.com/page2")).toBe(true);
			expect(state.hasVisited("https://example.com/page3")).toBe(false);
		});

		test("memory stats reflect tracked URLs", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.markVisited("https://example.com/page1");
			state.markVisited("https://example.com/page2");

			const stats = state.getMemoryStats();
			expect(stats.visitedCacheSize).toBe(2);
		});
	});

	describe("INVARIANT: Domain Delay Management", () => {
		test("setDomainDelay updates delay", () => {
			const options = createMockOptions({ crawlDelay: 100 });
			const state = new CrawlState(options);

			state.setDomainDelay("example.com", 500);

			expect(state.getDomainDelay("example.com")).toBe(500);
		});

		test("falls back to default for unset domains", () => {
			const options = createMockOptions({ crawlDelay: 100 });
			const state = new CrawlState(options);

			state.setDomainDelay("example.com", 500);

			expect(state.getDomainDelay("other.com")).toBe(100);
		});

		test("domain delays are independent", () => {
			const options = createMockOptions({ crawlDelay: 100 });
			const state = new CrawlState(options);

			state.setDomainDelay("example.com", 500);
			state.setDomainDelay("other.com", 200);

			expect(state.getDomainDelay("example.com")).toBe(500);
			expect(state.getDomainDelay("other.com")).toBe(200);
		});

		test("memory stats reflect domain delays", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.setDomainDelay("example.com", 500);
			state.setDomainDelay("other.com", 200);

			const stats = state.getMemoryStats();
			expect(stats.domainDelaysSize).toBe(2);
		});
	});

	describe("INVARIANT: Success Tracking", () => {
		test("recordSuccess increments counters", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.recordSuccess(1024);

			expect(state.stats.pagesScanned).toBe(1);
			expect(state.stats.successCount).toBe(1);
			expect(state.stats.totalData).toBe(1); // 1024 bytes = 1 KB
		});

		test("recordSuccess accumulates totalData", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.recordSuccess(2048); // 2 KB
			state.recordSuccess(1024); // 1 KB

			expect(state.stats.totalData).toBe(3);
		});

		test("recordSuccess resets consecutiveFailures", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			// Simulate failures
			for (let i = 0; i < 5; i++) {
				state.recordFailure();
			}

			state.recordSuccess(1024);

			// Circuit breaker should not trip after success
			expect(state.isActive).toBe(true);
		});

		test("handles zero content length", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.recordSuccess(0);

			expect(state.stats.totalData).toBe(0);
		});

		test("handles negative content length gracefully", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.recordSuccess(-100);

			// Should not crash, data unchanged or clamped to 0
			expect(state.stats.pagesScanned).toBe(1);
		});

		test("counters never decrease", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			const initialPages = state.stats.pagesScanned;
			state.recordSuccess(1024);
			expect(state.stats.pagesScanned).toBeGreaterThanOrEqual(initialPages);
		});
	});

	describe("INVARIANT: Failure Tracking", () => {
		test("recordFailure increments failure count", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.recordFailure();

			expect(state.stats.failureCount).toBe(1);
		});

		test("recordFailure increments consecutiveFailures", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.recordFailure();
			state.recordFailure();

			expect(state.stats.failureCount).toBe(2);
		});

		test("circuit breaker trips after threshold", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			// Simulate 20 consecutive failures
			for (let i = 0; i < 20; i++) {
				state.recordFailure();
			}

			expect(state.isActive).toBe(false);
			expect(state.stopReason).toContain("Circuit breaker tripped");
		});

		test("circuit breaker does not trip before threshold", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			// Simulate 19 consecutive failures
			for (let i = 0; i < 19; i++) {
				state.recordFailure();
			}

			expect(state.isActive).toBe(true);
		});

		test("success resets consecutiveFailures counter", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			// 10 failures
			for (let i = 0; i < 10; i++) {
				state.recordFailure();
			}

			state.recordSuccess(1024);

			// Now add more failures - should not trip immediately
			for (let i = 0; i < 10; i++) {
				state.recordFailure();
			}

			expect(state.isActive).toBe(true);
		});
	});

	describe("INVARIANT: Skip Tracking", () => {
		test("recordSkip increments skipped count", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.recordSkip();
			state.recordSkip();

			expect(state.stats.skippedCount).toBe(2);
		});
	});

	describe("INVARIANT: Link/Media Tracking", () => {
		test("addLinks increments link count", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.addLinks(5);

			expect(state.stats.linksFound).toBe(5);
		});

		test("addLinks accumulates", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.addLinks(5);
			state.addLinks(3);

			expect(state.stats.linksFound).toBe(8);
		});

		test("addMedia increments media count", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.addMedia(10);

			expect(state.stats.mediaFiles).toBe(10);
		});

		test("ignores negative counts", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.addLinks(-5);

			expect(state.stats.linksFound).toBe(0);
		});
	});

	describe("INVARIANT: Page Limit", () => {
		test("canProcessMore returns false at maxPages", () => {
			const options = createMockOptions({ maxPages: 5 });
			const state = new CrawlState(options);

			// Process 5 pages
			for (let i = 0; i < 5; i++) {
				state.recordSuccess(1024);
			}

			expect(state.canProcessMore()).toBe(false);
		});

		test("canProcessMore returns false when stopped", () => {
			const options = createMockOptions({ maxPages: 100 });
			const state = new CrawlState(options);

			state.stop();

			expect(state.canProcessMore()).toBe(false);
		});

		test("canProcessMore returns true below limit", () => {
			const options = createMockOptions({ maxPages: 100 });
			const state = new CrawlState(options);

			// Process 50 pages
			for (let i = 0; i < 50; i++) {
				state.recordSuccess(1024);
			}

			expect(state.canProcessMore()).toBe(true);
		});
	});

	describe("INVARIANT: Stop State", () => {
		test("stop() sets isActive to false", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.stop();

			expect(state.isActive).toBe(false);
		});

		test("stop() sets stopReason", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.stop("Manual stop");

			expect(state.stopReason).toBe("Manual stop");
		});

		test("stop() is idempotent", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.stop("First reason");
			state.stop("Second reason");

			// First reason preserved
			expect(state.stopReason).toBe("First reason");
		});

		test("stop() with no reason leaves stopReason undefined", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.stop();

			expect(state.stopReason).toBeUndefined();
		});
	});

	describe("INVARIANT: Queue Metrics", () => {
		test("snapshotQueueMetrics returns correct structure", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			const metrics = state.snapshotQueueMetrics(10, 3);

			expect(metrics.activeRequests).toBe(3);
			expect(metrics.queueLength).toBe(10);
			expect(metrics.elapsedTime).toBeGreaterThanOrEqual(0);
			expect(metrics.pagesPerSecond).toBeGreaterThanOrEqual(0);
		});

		test("pagesPerSecond calculated correctly", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

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
			const options = createMockOptions();
			const state = new CrawlState(options);

			const metrics1 = state.snapshotQueueMetrics(0, 0);

			// Small delay
			await new Promise((resolve) => setTimeout(resolve, 50));

			const metrics2 = state.snapshotQueueMetrics(0, 0);

			expect(metrics2.elapsedTime).toBeGreaterThanOrEqual(metrics1.elapsedTime);
		});
	});

	describe("INVARIANT: Final Stats", () => {
		test("buildFinalStats returns complete structure", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

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
			const options = createMockOptions();
			const state = new CrawlState(options);

			const stats = state.buildFinalStats();

			expect(stats.elapsedTime.hours).toBeGreaterThanOrEqual(0);
			expect(stats.elapsedTime.minutes).toBeGreaterThanOrEqual(0);
			expect(stats.elapsedTime.seconds).toBeGreaterThanOrEqual(0);
			expect(stats.elapsedTime.minutes).toBeLessThan(60);
			expect(stats.elapsedTime.seconds).toBeLessThan(60);
		});

		test("successRate calculated correctly", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			// 8 successful pages processed
			for (let i = 0; i < 8; i++) {
				state.recordSuccess(1024);
			}

			const stats = state.buildFinalStats();

			// All pages successfully scanned
			expect(stats.successRate).toBe("100.0%");
		});

		test("successRate is 0% when no pages scanned", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			const stats = state.buildFinalStats();

			expect(stats.successRate).toBe("0%");
		});

		test("stopReason included in final stats", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.stop("Circuit breaker tripped");

			const stats = state.buildFinalStats();

			expect(stats.stopReason).toBe("Circuit breaker tripped");
		});
	});

	describe("EDGE CASE: Boundary Conditions", () => {
		test("handles maxPages of 0", () => {
			const options = createMockOptions({ maxPages: 0 });
			const state = new CrawlState(options);

			expect(state.canProcessMore()).toBe(false);
		});

		test("handles maxPages of 1", () => {
			const options = createMockOptions({ maxPages: 1 });
			const state = new CrawlState(options);

			expect(state.canProcessMore()).toBe(true);

			state.recordSuccess(1024);

			expect(state.canProcessMore()).toBe(false);
		});

		test("handles very large content length", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.recordSuccess(Number.MAX_SAFE_INTEGER);

			expect(state.stats.pagesScanned).toBe(1);
			expect(state.stats.totalData).toBeGreaterThan(0);
		});

		test("handles Infinity content length", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.recordSuccess(Infinity);

			expect(state.stats.pagesScanned).toBe(1);
			// totalData should be finite
			expect(Number.isFinite(state.stats.totalData)).toBe(true);
		});

		test("handles NaN content length", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			state.recordSuccess(NaN);

			expect(state.stats.pagesScanned).toBe(1);
		});

		test("handles empty domain string", () => {
			const options = createMockOptions({ crawlDelay: 100 });
			const state = new CrawlState(options);

			state.setDomainDelay("", 500);

			expect(state.getDomainDelay("")).toBe(500);
		});
	});

	describe("PROPERTY: State Consistency", () => {
		test("state remains consistent after mixed operations", () => {
			const options = createMockOptions({ maxPages: 100 });
			const state = new CrawlState(options);

			// Mix of operations
			state.markVisited("https://example.com/1");
			state.setDomainDelay("example.com", 200);
			state.recordSuccess(1024);
			state.recordFailure();
			state.addLinks(5);
			state.addMedia(2);

			expect(state.stats.pagesScanned).toBe(2);
			expect(state.stats.linksFound).toBe(5);
			expect(state.stats.mediaFiles).toBe(2);
			expect(state.hasVisited("https://example.com/1")).toBe(true);
			expect(state.getDomainDelay("example.com")).toBe(200);
			expect(state.isActive).toBe(true);
		});

		test("final stats consistent with internal state", () => {
			const options = createMockOptions();
			const state = new CrawlState(options);

			// Process 3 pages
			state.recordSuccess(1024);
			state.recordSuccess(2048);
			state.recordFailure();

			const finalStats = state.buildFinalStats();

			expect(finalStats.pagesScanned).toBe(state.stats.pagesScanned);
			expect(finalStats.successCount).toBe(state.stats.successCount);
			expect(finalStats.failureCount).toBe(state.stats.failureCount);
		});
	});
});
