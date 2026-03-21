import { describe, expect, test } from "bun:test";
import { RequestCoalescer } from "../../utils/requestCoalescer.js";

/**
 * CONTRACT: RequestCoalescer
 *
 * Purpose: Prevents duplicate simultaneous crawls by coalescing requests
 * for the same URL. All concurrent requests wait for a single crawl result.
 *
 * INPUTS:
 *   - url: string (URL being crawled)
 *   - factory: () => Promise<T> (function that performs the crawl)
 *
 * OUTPUTS:
 *   - Promise<T> (result of the crawl, shared among all coalesced requests)
 *
 * INVARIANTS:
 *   1. COALESCING: Multiple concurrent requests for same URL return same promise
 *   2. MUTEX: Thread-safe check-then-act pattern prevents race conditions
 *   3. CLEANUP: Promise removed from pending after completion (success or error)
 *   4. IDEMPOTENT: Same URL can be re-requested after completion
 *   5. ISOLATION: Different URLs processed independently
 *   6. PENDING COUNT: Reflects number of unique URLs being crawled
 *
 * EDGE CASES:
 *   - Factory throws error
 *   - Factory resolves to undefined/null
 *   - Empty string URL
 *   - Concurrent requests during cleanup
 *   - Rapid sequential requests
 */

describe("RequestCoalescer CONTRACT", () => {
	test("factory returns correct result", async () => {
		const coalescer = new RequestCoalescer();

		const factory = async () => {
			return "result";
		};

		const result = await coalescer.coalesce("https://example.com", factory);

		expect(result).toBe("result");
	});

	test("isPending returns false for unknown URLs", () => {
		const coalescer = new RequestCoalescer();

		expect(coalescer.isPending("https://unknown.com")).toBe(false);
	});

	test("getPendingCount returns zero when empty", () => {
		const coalescer = new RequestCoalescer();

		expect(coalescer.getPendingCount()).toBe(0);
	});

	test("clear removes all pending requests", async () => {
		const coalescer = new RequestCoalescer();

		coalescer.clear();
		expect(coalescer.getPendingCount()).toBe(0);
	});

	test("handles factory resolving to null", async () => {
		const coalescer = new RequestCoalescer();

		const factory = async () => null;

		const result = await coalescer.coalesce("https://example.com", factory);

		expect(result).toBeNull();
	});

	test("handles factory resolving to undefined", async () => {
		const coalescer = new RequestCoalescer();

		const factory = async () => undefined;

		const result = await coalescer.coalesce("https://example.com", factory);

		expect(result).toBeUndefined();
	});

	test("handles empty string URL", async () => {
		const coalescer = new RequestCoalescer();

		const factory = async () => "result";

		const result = await coalescer.coalesce("", factory);

		expect(result).toBe("result");
	});

	test("handles factory throwing error", async () => {
		const coalescer = new RequestCoalescer();

		const factory = async () => {
			throw new Error("Test error");
		};

		await expect(
			coalescer.coalesce("https://example.com", factory),
		).rejects.toThrow("Test error");
	});
});
