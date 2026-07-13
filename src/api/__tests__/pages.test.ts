import { describe, expect, test } from "bun:test";
import { createPageContentRequestSignal } from "../pages";

describe("page content request lifetime", () => {
	test("component lifetime cancellation aborts the composed request signal", () => {
		const lifetime = new AbortController();
		const requestSignal = createPageContentRequestSignal(lifetime.signal, 60_000);

		expect(requestSignal.aborted).toBe(false);
		lifetime.abort();
		expect(requestSignal.aborted).toBe(true);
	});

	test("request timeout remains a separate bounded cancellation trigger", async () => {
		const lifetime = new AbortController();
		const requestSignal = createPageContentRequestSignal(lifetime.signal, 1);

		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(lifetime.signal.aborted).toBe(false);
		expect(requestSignal.aborted).toBe(true);
	});
});
