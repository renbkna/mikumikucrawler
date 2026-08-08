import { describe, expect, test } from "bun:test";
import { OperationTimeoutError, runWithTimeout } from "../timeout.js";

describe("runWithTimeout", () => {
	test("aborts the operation signal when the timeout expires", async () => {
		let observedSignal: AbortSignal | undefined;
		let settled = false;

		await expect(
			runWithTimeout({
				timeoutMs: 5,
				operationName: "Observed operation",
				run: (signal) => {
					observedSignal = signal;
					return new Promise<void>((resolve) => {
						signal.addEventListener(
							"abort",
							() => {
								settled = true;
								resolve();
							},
							{ once: true },
						);
					});
				},
			}),
		).rejects.toThrow("Timeout: Observed operation exceeded 5ms");

		expect(observedSignal?.aborted).toBe(true);
		expect(settled).toBe(true);
	});

	test("external abort rejects with the external abort reason", async () => {
		const controller = new AbortController();
		const promise = runWithTimeout({
			timeoutMs: 1000,
			operationName: "External operation",
			signal: controller.signal,
			run: (signal) =>
				new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
				}),
		});

		controller.abort(new Error("external stop"));

		await expect(promise).rejects.toThrow("external stop");
	});

	test("exposes timeout errors as a distinct type", async () => {
		await expect(
			runWithTimeout({
				timeoutMs: 5,
				operationName: "Typed operation",
				run: (signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener("abort", () => resolve(), { once: true });
					}),
			}),
		).rejects.toBeInstanceOf(OperationTimeoutError);
	});
});
