import { describe, expect, test } from "bun:test";
import { readLimitedResponseBody } from "../responseBody.js";

describe("readLimitedResponseBody", () => {
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
});
