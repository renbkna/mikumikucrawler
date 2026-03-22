import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { compression } from "../compression.js";

describe("compression middleware", () => {
	test("skips compression for SSE responses without draining the stream", async () => {
		const encoder = new TextEncoder();
		let canceled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("data: hello\n\n"));
			},
			cancel() {
				canceled = true;
			},
		});
		const app = new Elysia().use(compression()).get(
			"/events",
			() =>
				new Response(stream, {
					headers: {
						"content-type": "text/event-stream",
					},
				}),
		);

		const response = (await Promise.race([
			app.handle(
				new Request("http://localhost/events", {
					headers: { "accept-encoding": "gzip, br" },
				}),
			),
			Bun.sleep(100).then(() => {
				throw new Error("SSE response was blocked by compression middleware");
			}),
		])) as Response;

		expect(response.headers.get("content-encoding")).toBeNull();
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const chunk = await Promise.race([
			reader?.read(),
			Bun.sleep(100).then(() => {
				throw new Error("Timed out waiting for the first SSE chunk");
			}),
		]);
		expect(chunk?.done).toBe(false);
		expect(new TextDecoder().decode(chunk?.value)).toContain("data: hello");
		await reader?.cancel();
		expect(canceled).toBe(true);
	});
});
