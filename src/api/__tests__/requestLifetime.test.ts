import { describe, expect, test } from "bun:test";
import { createRequestSignal } from "../requestLifetime";

describe("API request lifetime", () => {
	test("is bounded by both controller cancellation and a request timeout", async () => {
		const lifetime = new AbortController();
		const cancelled = createRequestSignal(lifetime.signal, 1_000);
		lifetime.abort(new Error("controller disposed"));
		expect(cancelled.aborted).toBe(true);

		const timedOut = createRequestSignal(undefined, 5);
		await Bun.sleep(10);
		expect(timedOut.aborted).toBe(true);
	});
});
