import { describe, expect, test } from "bun:test";
import type { CrawlOptions } from "../../../contracts/crawl.js";
import { CrawlState } from "../CrawlState.js";

/**
 * CONTRACT: CrawlState
 *
 * Tracks crawl progress with these invariants:
 *   - counter identity: pagesScanned = successCount + failureCount + skippedCount
 *   - circuit breaker: auto-stop after 20 consecutive failures
 *   - terminal idempotency: recordTerminal returns false for duplicate URLs
 *   - domain rate adaptation: only responds to 429/503/403
 *   - domain budget: maxPagesPerDomain=0 means unlimited
 *   - canScheduleMore: false when stopped OR pagesScanned >= maxPages
 */

function makeOptions(overrides: Partial<CrawlOptions> = {}): CrawlOptions {
	return {
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
		...overrides,
	};
}

describe("CrawlState", () => {
	describe("invariant: counter identity", () => {
		test("pagesScanned always equals success + failure + skipped", () => {
			const state = new CrawlState(makeOptions());

			state.recordTerminal("https://a.example/1", "success");
			state.recordTerminal("https://a.example/2", "failure");
			state.recordTerminal("https://a.example/3", "skip");
			state.recordTerminal("https://a.example/4", "success", {
				dataKb: 10,
			});

			const c = state.counters;
			expect(c.pagesScanned).toBe(
				c.successCount + c.failureCount + c.skippedCount,
			);
			expect(c.pagesScanned).toBe(4);
			expect(c.successCount).toBe(2);
			expect(c.failureCount).toBe(1);
			expect(c.skippedCount).toBe(1);
		});
	});

	describe("invariant: terminal idempotency", () => {
		test("recordTerminal returns false and does not double-count on duplicate URL", () => {
			const state = new CrawlState(makeOptions());

			expect(state.recordTerminal("https://a.example/1", "success")).toBe(true);
			expect(state.recordTerminal("https://a.example/1", "success")).toBe(
				false,
			);

			expect(state.counters.pagesScanned).toBe(1);
			expect(state.counters.successCount).toBe(1);
		});
	});

	describe("invariant: circuit breaker", () => {
		test("trips after 20 consecutive failures", () => {
			const state = new CrawlState(makeOptions({ maxPages: 100 }));

			for (let i = 0; i < 19; i++) {
				state.recordTerminal(`https://a.example/fail-${i}`, "failure");
			}
			expect(state.isStopRequested).toBe(false);

			state.recordTerminal("https://a.example/fail-19", "failure");
			expect(state.isStopRequested).toBe(true);
			expect(state.stopReason).toContain("Circuit breaker");
		});

		test("a success resets the consecutive failure count", () => {
			const state = new CrawlState(makeOptions({ maxPages: 100 }));

			for (let i = 0; i < 19; i++) {
				state.recordTerminal(`https://a.example/fail-${i}`, "failure");
			}
			// Success resets the counter
			state.recordTerminal("https://a.example/ok", "success");

			// 19 more failures should not trip the breaker (counter reset to 0)
			for (let i = 0; i < 19; i++) {
				state.recordTerminal(`https://a.example/fail-b-${i}`, "failure");
			}
			expect(state.isStopRequested).toBe(false);
		});
	});

	describe("canScheduleMore", () => {
		test("false when pagesScanned reaches maxPages", () => {
			const state = new CrawlState(makeOptions({ maxPages: 2 }));

			state.recordTerminal("https://a.example/1", "success");
			expect(state.canScheduleMore()).toBe(true);

			state.recordTerminal("https://a.example/2", "success");
			expect(state.canScheduleMore()).toBe(false);
		});

		test("false when stop requested", () => {
			const state = new CrawlState(makeOptions());
			expect(state.canScheduleMore()).toBe(true);

			state.requestStop("Manual stop");
			expect(state.canScheduleMore()).toBe(false);
		});
	});

	describe("domain rate adaptation", () => {
		test("doubles delay on 403", () => {
			const state = new CrawlState(makeOptions({ crawlDelay: 200 }));
			state.adaptDomainDelay("slow.example", 403);
			expect(state.getDomainDelay("slow.example")).toBe(400);
		});

		test("uses retryAfterMs when provided for 429", () => {
			const state = new CrawlState(makeOptions({ crawlDelay: 200 }));
			state.adaptDomainDelay("rate.example", 429, 5000);
			expect(state.getDomainDelay("rate.example")).toBe(5000);
		});

		test("ignores non-throttle status codes", () => {
			const state = new CrawlState(makeOptions({ crawlDelay: 200 }));
			state.adaptDomainDelay("ok.example", 200);
			state.adaptDomainDelay("ok.example", 404);
			state.adaptDomainDelay("ok.example", 500);
			// Should still be the default crawlDelay
			expect(state.getDomainDelay("ok.example")).toBe(200);
		});
	});

	describe("domain budget", () => {
		test("maxPagesPerDomain=0 means unlimited", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 0 }));
			for (let i = 0; i < 100; i++) {
				state.recordDomainPage("example.com");
			}
			expect(state.isDomainBudgetExceeded("example.com")).toBe(false);
		});

		test("enforces per-domain limit", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 3 }));
			state.recordDomainPage("example.com");
			state.recordDomainPage("example.com");
			expect(state.isDomainBudgetExceeded("example.com")).toBe(false);

			state.recordDomainPage("example.com");
			expect(state.isDomainBudgetExceeded("example.com")).toBe(true);
		});

		test("tracks domains independently", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 2 }));
			state.recordDomainPage("a.example");
			state.recordDomainPage("a.example");
			state.recordDomainPage("b.example");

			expect(state.isDomainBudgetExceeded("a.example")).toBe(true);
			expect(state.isDomainBudgetExceeded("b.example")).toBe(false);
		});
	});

	describe("domain rate limiting", () => {
		test("timeUntilDomainReady returns 0 for unreserved domains", () => {
			const state = new CrawlState(makeOptions());
			expect(state.timeUntilDomainReady("fresh.example")).toBe(0);
		});

		test("reserveDomain enforces crawlDelay", () => {
			const state = new CrawlState(makeOptions({ crawlDelay: 500 }));
			const now = 1000;
			state.reserveDomain("example.com", now);
			expect(state.timeUntilDomainReady("example.com", now + 100)).toBe(400);
			expect(state.timeUntilDomainReady("example.com", now + 500)).toBe(0);
		});
	});
});
