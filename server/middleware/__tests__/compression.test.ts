import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { compression } from "../compression.js";

async function decodeResponse(response: Response): Promise<string> {
	const body = Buffer.from(await response.arrayBuffer());
	const encoding = response.headers.get("content-encoding");
	if (encoding === "br") {
		return brotliDecompressSync(body).toString("utf8");
	}
	if (encoding === "gzip") {
		return gunzipSync(body).toString("utf8");
	}
	return body.toString("utf8");
}

describe("compression middleware", () => {
	test("serves exactly the compressed byte view for brotli responses", async () => {
		const app = new Elysia().use(compression()).get(
			"/large",
			() =>
				new Response("a".repeat(2000), {
					headers: { "content-type": "text/plain" },
				}),
		);

		const response = await app.handle(
			new Request("http://localhost/large", {
				headers: { "accept-encoding": "br" },
			}),
		);

		const body = await response.arrayBuffer();
		expect(response.headers.get("content-encoding")).toBe("br");
		expect(body.byteLength).toBe(
			Number(response.headers.get("content-length")),
		);
	});

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

	test("compresses large JSON and preserves vary plus content length", async () => {
		const app = new Elysia().use(compression()).get(
			"/api",
			() =>
				new Response(JSON.stringify({ items: ["miku".repeat(1000)] }), {
					headers: {
						"content-type": "application/json",
						vary: "cookie",
					},
				}),
		);

		const response = await app.handle(
			new Request("http://localhost/api", {
				headers: { "accept-encoding": "gzip" },
			}),
		);

		const body = await response.arrayBuffer();
		expect(response.headers.get("content-encoding")).toBe("gzip");
		expect(response.headers.get("vary")).toBe("cookie, accept-encoding");
		expect(body.byteLength).toBe(
			Number(response.headers.get("content-length")),
		);
	});

	test("compresses large Elysia object responses after serialization", async () => {
		const app = new Elysia()
			.use(compression())
			.get("/api-object", () => ({ items: ["miku".repeat(1000)] }));

		const response = await app.handle(
			new Request("http://localhost/api-object", {
				headers: { "accept-encoding": "br, gzip" },
			}),
		);

		expect(response.headers.get("content-encoding")).toBe("br");
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await decodeResponse(response)).toBe(
			JSON.stringify({ items: ["miku".repeat(1000)] }),
		);
	});

	test("preserves named statuses when normalizing object responses", async () => {
		const app = new Elysia().use(compression()).get("/conflict", ({ set }) => {
			set.status = "Conflict";
			return { error: "conflict", items: ["miku".repeat(1000)] };
		});

		const response = await app.handle(
			new Request("http://localhost/conflict", {
				headers: { "accept-encoding": "gzip" },
			}),
		);

		expect(response.status).toBe(409);
		expect(response.headers.get("content-encoding")).toBe("gzip");
		expect(await decodeResponse(response)).toBe(
			JSON.stringify({ error: "conflict", items: ["miku".repeat(1000)] }),
		);
	});

	test("honors accept-encoding q-values when selecting compression", async () => {
		const app = new Elysia().use(compression()).get(
			"/weighted",
			() =>
				new Response("miku".repeat(1000), {
					headers: { "content-type": "text/plain" },
				}),
		);

		const response = await app.handle(
			new Request("http://localhost/weighted", {
				headers: { "accept-encoding": "br;q=0, gzip;q=1" },
			}),
		);

		expect(response.headers.get("content-encoding")).toBe("gzip");
		expect(await decodeResponse(response)).toBe("miku".repeat(1000));
	});

	test("does not compress when every supported encoding is rejected", async () => {
		const app = new Elysia().use(compression()).get(
			"/identity",
			() =>
				new Response("miku".repeat(1000), {
					headers: { "content-type": "text/plain" },
				}),
		);

		const response = await app.handle(
			new Request("http://localhost/identity", {
				headers: { "accept-encoding": "br;q=0, gzip;q=0" },
			}),
		);

		expect(response.headers.get("content-encoding")).toBeNull();
		expect(await response.text()).toBe("miku".repeat(1000));
	});

	test("compresses large text Blob responses such as SPA files", async () => {
		const html = `<main>${"miku".repeat(1000)}</main>`;
		const app = new Elysia()
			.use(compression())
			.get("/index.html", () => new Blob([html], { type: "text/html" }));

		const response = await app.handle(
			new Request("http://localhost/index.html", {
				headers: { "accept-encoding": "gzip" },
			}),
		);

		expect(response.headers.get("content-encoding")).toBe("gzip");
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await decodeResponse(response)).toBe(html);
	});

	test("skips binary and already-compressed response types", async () => {
		const app = new Elysia()
			.use(compression())
			.get(
				"/binary",
				() =>
					new Response(new Uint8Array(4000), {
						headers: { "content-type": "application/octet-stream" },
					}),
			)
			.get(
				"/archive",
				() =>
					new Response(new Uint8Array(4000), {
						headers: { "content-type": "application/zip" },
					}),
			);

		for (const path of ["/binary", "/archive"]) {
			const response = await app.handle(
				new Request(`http://localhost${path}`, {
					headers: { "accept-encoding": "br, gzip" },
				}),
			);
			expect(response.headers.get("content-encoding")).toBeNull();
			expect((await response.arrayBuffer()).byteLength).toBe(4000);
		}
	});
});
