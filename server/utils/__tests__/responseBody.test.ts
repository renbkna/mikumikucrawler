import { describe, expect, test } from "bun:test";
import { readLimitedResponseBody } from "../responseBody.js";

describe("readLimitedResponseBody", () => {
	test("honors cancellation before an empty response is read", async () => {
		const controller = new AbortController();
		controller.abort(new Error("request canceled"));

		await expect(
			readLimitedResponseBody(new Response(null), 10, controller.signal),
		).rejects.toThrow("request canceled");
	});

	test("cancels declared oversized bodies without reading chunks", async () => {
		let read = false;
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			pull() {
				read = true;
			},
			cancel() {
				canceled = true;
			},
		});

		const result = await readLimitedResponseBody(
			new Response(body, {
				headers: { "content-length": "11" },
			}),
			10,
		);

		expect(result).toEqual({ type: "tooLarge" });
		expect(read).toBe(false);
		expect(canceled).toBe(true);
	});

	test("cancels streamed bodies as soon as the byte ceiling is crossed", async () => {
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(6));
				controller.enqueue(new Uint8Array(5));
			},
			cancel() {
				canceled = true;
			},
		});

		const result = await readLimitedResponseBody(new Response(body), 10);

		expect(result).toEqual({ type: "tooLarge" });
		expect(canceled).toBe(true);
	});

	test("aborts and cancels a stalled body read", async () => {
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				canceled = true;
			},
		});
		const controller = new AbortController();
		const read = readLimitedResponseBody(new Response(body), 10, controller.signal);

		controller.abort(new Error("body deadline"));

		await expect(read).rejects.toThrow("body deadline");
		expect(canceled).toBe(true);
	});
});
