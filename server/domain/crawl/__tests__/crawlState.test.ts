import { describe, expect, test } from "bun:test";
import type { CrawlOptions } from "../../../../shared/contracts/index.js";
import { CrawlState } from "../CrawlState.js";
import {
	deriveTerminalCounters,
	type TerminalCounterEffects,
	type TerminalOutcome,
} from "../completion.js";

/**
 * CONTRACT: CrawlState
 *
 * Tracks crawl progress with these invariants:
 *   - counter identity: pagesScanned = successCount + failureCount + skippedCount
 *   - circuit breaker: auto-stop after 20 consecutive failures
 *   - terminal identity: a URL can enter terminal state exactly once
 *   - domain rate adaptation: only responds to 429/503/403
 *   - domain budget: maxPagesPerDomain=0 means unlimited
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

function makeCounters(successCount = 0, failureCount = 0, skippedCount = 0) {
	return {
		pagesScanned: successCount + failureCount + skippedCount,
		successCount,
		failureCount,
		skippedCount,
		linksFound: 0,
		mediaFiles: 0,
		totalDataKb: 0,
	};
}

// Model the durable commit input; assertions below independently specify its observable effects.
function complete(
	state: CrawlState,
	url: string,
	outcome: TerminalOutcome,
	effects: TerminalCounterEffects = {},
	chargedDomain: string | null = new URL(url).hostname,
) {
	if (state.canAdmit(url, new URL(url).hostname)) {
		state.recordAdmission(url, new URL(url).hostname);
	}
	state.applyCommittedTerminal(url, outcome, {
		counters: deriveTerminalCounters(state.snapshotCounters(), outcome, effects),
		effects,
		chargedDomain,
	});
}

describe("CrawlState", () => {
	describe("invariant: counter identity", () => {
		test("counter inputs and progress observations cannot mutate the owned aggregate", () => {
			const initial = makeCounters();
			const state = new CrawlState(makeOptions(), initial);
			initial.pagesScanned = 100;
			expect(state.hasPageCapacity()).toBe(true);
			const progress = state.buildProgress({ activeRequests: 0, queueLength: 0 });
			progress.counters.failureCount = 100;
			const snapshot = state.snapshotCounters();
			snapshot.successCount = 100;
			expect(state.snapshotCounters()).toEqual(makeCounters());
			complete(state, "https://example.com/done", "success");
			expect(initial.successCount).toBe(0);
			expect(progress.counters.successCount).toBe(0);
			expect(state.snapshotCounters()).toEqual(makeCounters(1));
		});

		test("pagesScanned always equals success + failure + skipped", () => {
			const state = new CrawlState(makeOptions());

			complete(state, "https://a.example/1", "success");
			complete(state, "https://a.example/2", "failure");
			complete(state, "https://a.example/3", "skip");
			complete(state, "https://a.example/4", "success", {
				dataKb: 10,
				mediaFiles: 2,
				discoveredLinks: 3,
			});

			const c = state.snapshotCounters();
			expect(c.pagesScanned).toBe(c.successCount + c.failureCount + c.skippedCount);
			expect(c.pagesScanned).toBe(4);
			expect(c.successCount).toBe(2);
			expect(c.failureCount).toBe(1);
			expect(c.skippedCount).toBe(1);
			expect(c.totalDataKb).toBe(10);
			expect(c.mediaFiles).toBe(2);
			expect(c.linksFound).toBe(3);
			expect(state.hasVisited("https://a.example/1")).toBe(true);
		});
	});

	describe("invariant: terminal identity", () => {
		test("completion rejects a duplicate URL without changing counters", () => {
			const state = new CrawlState(makeOptions());

			complete(state, "https://a.example/1", "success");
			expect(() => complete(state, "https://a.example/1", "success")).toThrow(
				"Cannot complete already-terminal URL: https://a.example/1",
			);

			expect(state.snapshotCounters().pagesScanned).toBe(1);
			expect(state.snapshotCounters().successCount).toBe(1);
		});

		test("restoreTerminals rejects duplicate input before restoring any record", () => {
			const state = new CrawlState(makeOptions());

			expect(() =>
				state.restoreTerminals([
					{ url: "https://a.example/1", outcome: "success" },
					{ url: "https://a.example/1", outcome: "failure" },
				]),
			).toThrow("Cannot restore duplicate terminal URL: https://a.example/1");
			expect(state.hasVisited("https://a.example/1")).toBe(false);
		});

		test("restoreTerminals rejects invalid persisted identity before restoring any record", () => {
			const state = new CrawlState(makeOptions());

			expect(() =>
				state.restoreTerminals([
					{ url: "https://a.example/valid", outcome: "success" },
					{ url: "not a URL", outcome: "failure", domainBudgetCharged: true },
				]),
			).toThrow("Cannot restore invalid terminal URL: not a URL");
			expect(state.hasVisited("https://a.example/valid")).toBe(false);
		});
	});

	describe("invariant: circuit breaker", () => {
		test("trips after 20 consecutive failures", () => {
			const state = new CrawlState(makeOptions({ maxPages: 100 }));

			for (let i = 0; i < 19; i++) {
				complete(state, `https://a.example/fail-${i}`, "failure");
			}
			expect(state.isStopRequested).toBe(false);

			complete(state, "https://a.example/fail-19", "failure");
			expect(state.isStopRequested).toBe(true);
			expect(state.stopReason).toContain("Circuit breaker");
		});

		test("a success resets the consecutive failure count", () => {
			const state = new CrawlState(makeOptions({ maxPages: 100 }));

			for (let i = 0; i < 19; i++) {
				complete(state, `https://a.example/fail-${i}`, "failure");
			}
			// Success resets the counter
			complete(state, "https://a.example/ok", "success");

			// 19 more failures should not trip the breaker (counter reset to 0)
			for (let i = 0; i < 19; i++) {
				complete(state, `https://a.example/fail-b-${i}`, "failure");
			}
			expect(state.isStopRequested).toBe(false);
		});

		test("a skip resets the consecutive failure count", () => {
			const state = new CrawlState(makeOptions({ maxPages: 100 }));

			for (let i = 0; i < 19; i++) {
				complete(state, `https://a.example/fail-${i}`, "failure");
			}
			complete(state, "https://a.example/skipped", "skip");
			complete(state, "https://a.example/fail-after-skip", "failure");

			expect(state.isStopRequested).toBe(false);
		});

		test("a restored skip resets the restored failure streak", () => {
			const state = new CrawlState(makeOptions({ maxPages: 100 }), makeCounters(0, 19, 1));

			state.restoreTerminals([
				...Array.from({ length: 19 }, (_, index) => ({
					url: `https://a.example/restored-fail-${index}`,
					outcome: "failure" as const,
				})),
				{ url: "https://a.example/restored-skip", outcome: "skip" },
			]);
			complete(state, "https://a.example/fail-after-restored-skip", "failure");

			expect(state.isStopRequested).toBe(false);
		});

		test("restored failures preserve the circuit breaker streak across resume", () => {
			const state = new CrawlState(makeOptions({ maxPages: 100 }), makeCounters(0, 19));

			state.restoreTerminals(
				Array.from({ length: 19 }, (_, index) => ({
					url: `https://a.example/restored-fail-${index}`,
					outcome: "failure" as const,
				})),
			);
			expect(state.isStopRequested).toBe(false);

			complete(state, "https://a.example/fail-after-resume", "failure");
			expect(state.isStopRequested).toBe(true);
			expect(state.stopReason).toContain("Circuit breaker");
		});

		test("restored failures trip the circuit breaker when resume starts at the threshold", () => {
			const state = new CrawlState(makeOptions({ maxPages: 100 }), makeCounters(0, 20));

			state.restoreTerminals(
				Array.from({ length: 20 }, (_, index) => ({
					url: `https://a.example/restored-threshold-${index}`,
					outcome: "failure" as const,
				})),
			);

			expect(state.isStopRequested).toBe(true);
			expect(state.stopReason).toBe("Circuit breaker tripped after 20 consecutive failures");
		});
	});

	describe("restored admission policy", () => {
		test("rejects crawl-wide and domain overflow before exposing any restored admission", () => {
			const globalState = new CrawlState(makeOptions({ maxPages: 1 }));
			expect(() =>
				globalState.restoreQueueAdmissions([
					{ url: "https://a.example/1", domain: "a.example" },
					{ url: "https://b.example/2", domain: "b.example" },
				]),
			).toThrow("Restored queue exceeds the crawl page budget");
			expect(globalState.canAdmit("https://a.example/1", "a.example")).toBe(true);

			const domainState = new CrawlState(makeOptions({ maxPages: 3, maxPagesPerDomain: 1 }));
			expect(() =>
				domainState.restoreQueueAdmissions([
					{ url: "https://a.example/1", domain: "a.example" },
					{ url: "https://a.example/2", domain: "a.example" },
				]),
			).toThrow("Restored queue exceeds the domain page budget");
			expect(domainState.canAdmit("https://a.example/1", "a.example")).toBe(true);
		});

		test("restored terminal rows must exactly match the durable terminal counter", () => {
			const state = new CrawlState(makeOptions({ maxPages: 3 }), {
				pagesScanned: 1,
				successCount: 1,
				failureCount: 0,
				skippedCount: 0,
				linksFound: 0,
				mediaFiles: 0,
				totalDataKb: 0,
			});

			expect(() => state.restoreTerminals([])).toThrow(
				"Persisted terminal rows must match the durable terminal counter",
			);
		});
	});

	describe("committed completion ownership", () => {
		test("unadmitted and mismatched commits cannot partially settle a URL", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 1 }));
			const url = "https://source.example/page";
			const commit = {
				counters: makeCounters(1),
				effects: {},
				chargedDomain: "destination.example",
			};
			expect(() => state.applyCommittedTerminal(url, "success", commit)).toThrow(
				"Missing crawl admission",
			);
			expect(state.snapshotCounters()).toEqual(makeCounters());
			state.recordAdmission(url, "source.example");
			expect(state.tryReserveRedirectDomain(url, "destination.example")).toBe(true);
			expect(() =>
				state.applyCommittedTerminal(url, "success", { ...commit, counters: makeCounters(2) }),
			).toThrow("diverged");
			expect(state.hasVisited(url)).toBe(false);
			expect(state.snapshotCounters()).toEqual(makeCounters());
			expect(state.canAdmit("https://source.example/other", "source.example")).toBe(false);
			expect(state.canAdmit("https://destination.example/other", "destination.example")).toBe(
				false,
			);
			state.applyCommittedTerminal(url, "success", commit);
			expect(state.hasVisited(url)).toBe(true);
			expect(state.snapshotCounters()).toEqual(makeCounters(1));
			expect(state.canAdmit("https://source.example/other", "source.example")).toBe(true);
			expect(state.isDomainBudgetExceeded("source.example")).toBe(false);
			expect(state.isDomainBudgetExceeded("destination.example")).toBe(true);
			// Ending an old attempt cannot release the now-settled destination charge.
			state.releaseAttempt(url);
			expect(state.canAdmit("https://destination.example/other", "destination.example")).toBe(
				false,
			);
		});

		test("invalid or over-budget domain facts leave admissions and counters intact", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 1 }));
			const url = "https://source.example/page";
			state.recordAdmission(url, "source.example");
			complete(state, "https://full.example/page", "success");
			for (const chargedDomain of ["full.example", "invalid/domain"]) {
				expect(() =>
					state.applyCommittedTerminal(url, "success", {
						counters: makeCounters(2),
						effects: {},
						chargedDomain,
					}),
				).toThrow();
				expect(state.hasVisited(url)).toBe(false);
				expect(state.snapshotCounters()).toEqual(makeCounters(1));
				expect(state.canAdmit("https://source.example/other", "source.example")).toBe(false);
			}
			complete(state, url, "skip", {}, null);
			expect(state.canAdmit("https://source.example/other", "source.example")).toBe(true);
			expect(state.snapshotCounters()).toEqual(makeCounters(1, 0, 1));
		});
	});

	describe("domain rate adaptation", () => {
		test("doubles delay on 403", () => {
			const state = new CrawlState(makeOptions({ crawlDelay: 200 }));
			state.adaptDomainDelay("slow.example", 403);
			expect(state.getDomainDelay("slow.example")).toBe(400);
		});

		test("403 backs off from the configured floor when robots requests zero delay", () => {
			const state = new CrawlState(makeOptions({ crawlDelay: 200 }));
			state.setDomainDelay("zero-delay.example", 0);

			state.adaptDomainDelay("zero-delay.example", 403);

			expect(state.getDomainDelay("zero-delay.example")).toBe(400);
		});

		test("uses retryAfterMs when provided for 429", () => {
			const state = new CrawlState(makeOptions({ crawlDelay: 200 }));
			state.adaptDomainDelay("rate.example", 429, 5000);
			expect(state.getDomainDelay("rate.example")).toBe(5000);
		});

		test("robots delay cannot lower the configured crawl delay", () => {
			const state = new CrawlState(makeOptions({ crawlDelay: 500 }));
			state.setDomainDelay("robots.example", 100);
			expect(state.getDomainDelay("robots.example")).toBe(500);
		});

		test("adaptive delay saturates at the finite scheduler ceiling", () => {
			const state = new CrawlState(makeOptions({ crawlDelay: 200 }));
			state.adaptDomainDelay("rate.example", 429, Number.POSITIVE_INFINITY);
			expect(state.getDomainDelay("rate.example")).toBe(60_000);
			state.adaptDomainDelay("rate.example", 403);
			expect(state.getDomainDelay("rate.example")).toBe(60_000);
		});

		test("rejects non-finite scheduler state", () => {
			const state = new CrawlState(makeOptions());
			expect(() => state.setDomainDelay("invalid.example", Number.POSITIVE_INFINITY)).toThrow(
				"Domain delay must be finite",
			);
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
		test("redirect reservations exclude concurrent admissions to the destination domain", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 1 }));
			state.recordAdmission("https://source.example/start", "source.example");

			expect(
				state.tryReserveRedirectDomain("https://source.example/start", "destination.example"),
			).toBe(true);
			expect(state.canAdmit("https://destination.example/other", "destination.example")).toBe(
				false,
			);

			state.releaseAttempt("https://source.example/start");
			expect(state.canAdmit("https://destination.example/other", "destination.example")).toBe(true);
		});

		test("uncharged terminal work releases its reserved domain capacity", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 1 }), makeCounters(0, 0, 1));

			expect(state.canAdmit("https://example.com/first", "example.com")).toBe(true);
			state.recordAdmission("https://example.com/first", "example.com");
			expect(state.canAdmit("https://example.com/second", "example.com")).toBe(false);

			complete(state, "https://example.com/first", "skip", {}, null);
			expect(state.canAdmit("https://example.com/second", "example.com")).toBe(true);
		});

		test("maxPagesPerDomain=0 means unlimited", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 0, maxPages: 100 }));
			for (let i = 0; i < 100; i++) {
				complete(state, `https://example.com/${state.snapshotCounters().pagesScanned}`, "success");
			}
			expect(state.isDomainBudgetExceeded("example.com")).toBe(false);
		});

		test("enforces per-domain limit", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 3 }));
			complete(state, `https://example.com/${state.snapshotCounters().pagesScanned}`, "success");
			complete(state, `https://example.com/${state.snapshotCounters().pagesScanned}`, "success");
			expect(state.isDomainBudgetExceeded("example.com")).toBe(false);

			complete(state, `https://example.com/${state.snapshotCounters().pagesScanned}`, "success");
			expect(state.isDomainBudgetExceeded("example.com")).toBe(true);
		});

		test("tracks domains independently", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 2 }));
			complete(state, `https://a.example/${state.snapshotCounters().pagesScanned}`, "success");
			complete(state, `https://a.example/${state.snapshotCounters().pagesScanned}`, "success");
			complete(state, "https://b.example/1", "success");

			expect(state.isDomainBudgetExceeded("a.example")).toBe(true);
			expect(state.isDomainBudgetExceeded("b.example")).toBe(false);
		});

		test("restores persisted domain budget charges across resume", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 1 }), makeCounters(0, 0, 1));

			state.restoreTerminals([
				{
					url: "https://example.com/noindex",
					outcome: "skip",
					domainBudgetCharged: true,
				},
			]);

			expect(state.isDomainBudgetExceeded("example.com")).toBe(true);
		});

		test("does not infer domain budget charges from terminal outcome alone", () => {
			const state = new CrawlState(makeOptions({ maxPagesPerDomain: 1 }), makeCounters(0, 0, 1));

			state.restoreTerminals([
				{
					url: "https://example.com/prefetch-skip",
					outcome: "skip",
					domainBudgetCharged: false,
				},
			]);

			expect(state.isDomainBudgetExceeded("example.com")).toBe(false);
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

		test("setDomainDelay seeds a durable next-ready watermark", () => {
			const changes: unknown[] = [];
			const state = new CrawlState(makeOptions({ crawlDelay: 100 }), undefined, {
				onDomainStateChanged: (record) => changes.push(record),
			});

			state.setDomainDelay("https://example.com", 750, 2000);

			expect(state.timeUntilDomainReady("https://example.com", 2500)).toBe(250);
			expect(changes).toEqual([
				{
					delayKey: "https://example.com",
					delayMs: 750,
					nextAllowedAt: 2750,
				},
			]);
		});
	});
});
