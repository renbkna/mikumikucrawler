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
});
