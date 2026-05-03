import { describe, expect, test } from "bun:test";
import {
	OperationTimeoutError,
	runWithTimeout,
	runWithTimeoutFallback,
} from "../timeout.js";

describe("runWithTimeout", () => {
	test("aborts the operation signal when the timeout expires", async () => {
		let observedSignal: AbortSignal | undefined;

		await expect(
			runWithTimeout({
				timeoutMs: 5,
				operationName: "Observed operation",
				run: (signal) => {
					observedSignal = signal;
					return new Promise(() => undefined);
				},
			}),
		).rejects.toThrow("Timeout: Observed operation exceeded 5ms");

		expect(observedSignal?.aborted).toBe(true);
	});

	test("external abort rejects with the external abort reason", async () => {
		const controller = new AbortController();
		const promise = runWithTimeout({
			timeoutMs: 1000,
			operationName: "External operation",
			signal: controller.signal,
			run: () => new Promise(() => undefined),
		});

		controller.abort(new Error("external stop"));

		await expect(promise).rejects.toThrow("external stop");
	});

	test("exposes timeout errors as a distinct type", async () => {
		await expect(
			runWithTimeout({
				timeoutMs: 5,
				operationName: "Typed operation",
				run: () => new Promise(() => undefined),
			}),
		).rejects.toBeInstanceOf(OperationTimeoutError);
	});
});

describe("runWithTimeoutFallback", () => {
	test("returns fallback only when the timeout expires", async () => {
		await expect(
			runWithTimeoutFallback({
				timeoutMs: 5,
				operationName: "Fallback operation",
				fallback: "fallback",
				run: () => new Promise<string>(() => undefined),
			}),
		).resolves.toBe("fallback");
	});

	test("does not hide operation failures", async () => {
		await expect(
			runWithTimeoutFallback({
				timeoutMs: 1000,
				operationName: "Failing operation",
				fallback: "fallback",
				run: async () => {
					throw new Error("operation failed");
				},
			}),
		).rejects.toThrow("operation failed");
	});
});
