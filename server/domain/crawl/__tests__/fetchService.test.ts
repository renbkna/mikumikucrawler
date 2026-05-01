import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../../config/logging.js";
import { config } from "../../../config/env.js";
import { FetchService } from "../FetchService.js";

function createLogger(): Logger {
	return {
		level: "info",
		info: mock(() => undefined),
		warn: mock(() => undefined),
		error: mock(() => undefined),
		debug: mock(() => undefined),
		fatal: mock(() => undefined),
		trace: mock(() => undefined),
		silent: mock(() => undefined),
		child: mock(() => createLogger()),
	} as unknown as Logger;
}

describe("fetch service contract", () => {
	test("does not fall back to static crawl when a strict consent wall blocks dynamic rendering", async () => {
		const httpFetch = mock(async () => new Response("should not be called"));
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{ fetch: httpFetch },
			{
				isEnabled: () => true,
				render: async () => ({
					type: "consentBlocked",
					message:
						"Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
					statusCode: 403,
				}),
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://www.youtube.com/watch?v=test",
			domain: "www.youtube.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			type: "blocked",
			statusCode: 403,
			reason:
				"Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
		});
		expect(httpFetch).not.toHaveBeenCalled();
	});

	test("maps browser-rendered 403 responses to blocked instead of success", async () => {
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: mock(async () => new Response("should not be called")),
			},
			{
				isEnabled: () => true,
				render: async () => ({
					type: "success",
					result: {
						isDynamic: true,
						content: "<html>blocked</html>",
						statusCode: 403,
						contentType: "text/html",
						contentLength: 20,
						title: "Blocked",
						description: "",
						lastModified: undefined,
						etag: '"dynamic-blocked"',
						xRobotsTag: null,
					},
				}),
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/blocked",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			type: "blocked",
			statusCode: 403,
			reason: "Access blocked for https://example.com/blocked",
		});
	});

	test("maps unclassified browser-rendered HTTP errors to terminal failures", async () => {
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: mock(async () => new Response("should not be called")),
			},
			{
				isEnabled: () => true,
				render: async () => ({
					type: "success",
					result: {
						isDynamic: true,
						content: "<html>server error</html>",
						statusCode: 500,
						contentType: "text/html",
						contentLength: 25,
						title: "Server error",
						description: "",
						lastModified: undefined,
						etag: null,
						xRobotsTag: null,
					},
				}),
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/error",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			type: "permanentFailure",
			statusCode: 500,
		});
	});

	test("maps unclassified static HTTP errors to terminal failures", async () => {
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: async () => new Response("server error", { status: 500 }),
			},
			{
				isEnabled: () => false,
				render: async () => null,
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/static-error",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			type: "permanentFailure",
			statusCode: 500,
		});
	});

	test("honors browser-rendered retry-after values", async () => {
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: mock(async () => new Response("should not be called")),
			},
			{
				isEnabled: () => true,
				render: async () => ({
					type: "success",
					result: {
						isDynamic: true,
						content: "<html>rate limited</html>",
						statusCode: 429,
						contentType: "text/html",
						contentLength: 25,
						title: "Rate limited",
						description: "",
						lastModified: undefined,
						etag: null,
						xRobotsTag: null,
						retryAfter: "1",
					},
				}),
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/rate-limited-dynamic",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			type: "rateLimited",
			statusCode: 429,
			retryAfterMs: 1000,
		});
	});

	test("falls back to static fetch when dynamic rendering setup fails", async () => {
		const httpFetch = mock(
			async () =>
				new Response("<html><main>Static fallback</main></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		);
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{ fetch: httpFetch },
			{
				isEnabled: () => true,
				render: async () => {
					throw new Error("browser page creation failed");
				},
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/fallback",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.type).toBe("success");
		if (result.type !== "success") {
			throw new Error("Expected successful static fallback result");
		}
		expect(result.content).toBe("<html><main>Static fallback</main></html>");
		expect(result.isDynamic).toBe(false);
		expect(httpFetch).toHaveBeenCalled();
	});

	test("maps static 401 responses to blocked instead of thrown failures", async () => {
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: async () => new Response("auth required", { status: 401 }),
			},
			{
				isEnabled: () => false,
				render: async () => null,
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/private",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			type: "blocked",
			statusCode: 401,
			reason: "Access blocked for https://example.com/private",
		});
	});

	test("uses the configured crawler user-agent for static fetches", async () => {
		const seenHeaders: Array<Record<string, string> | undefined> = [];
		const httpFetch = mock(
			async (request: { headers?: Record<string, string> }) => {
				seenHeaders.push(request.headers);
				return new Response("<html><main>OK</main></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			},
		);
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{ fetch: httpFetch },
			{
				isEnabled: () => false,
				render: async () => null,
			} as never,
			createLogger(),
		);

		await service.fetch("crawl-1", {
			url: "https://example.com/ua",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(seenHeaders[0]?.["User-Agent"]).toBe(config.userAgent);
	});

	test("honors short HTTP-date retry-after values instead of forcing the max delay", async () => {
		const retryAfterAt = new Date(Date.now() + 5_000).toUTCString();
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: async () =>
					new Response("", {
						status: 429,
						headers: { "retry-after": retryAfterAt },
					}),
			},
			{
				isEnabled: () => false,
				render: async () => null,
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/rate-limited",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.type).toBe("rateLimited");
		if (result.type !== "rateLimited") {
			throw new Error("Expected rate-limited result");
		}
		expect(result.retryAfterMs).toBeLessThan(10_000);
		expect(result.retryAfterMs).toBeGreaterThan(0);
	});

	test("measures contentLength from the decoded response body instead of the header value", async () => {
		const content =
			"<html><body><main>This body is longer than the compressed header would imply.</main></body></html>";
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: async () =>
					new Response(content, {
						status: 200,
						headers: {
							"content-type": "text/html",
							"content-length": "12",
							"content-encoding": "gzip",
						},
					}),
			},
			{
				isEnabled: () => false,
				render: async () => null,
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/decoded",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.type).toBe("success");
		if (result.type !== "success") {
			throw new Error("Expected successful static fetch result");
		}
		expect(result.contentLength).toBe(Buffer.byteLength(content, "utf8"));
	});

	test("preserves static PDF response bytes instead of text-decoding them", async () => {
		const pdfBytes = new Uint8Array([
			0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0x00,
		]);
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: async () =>
					new Response(pdfBytes, {
						status: 200,
						headers: { "content-type": "Application/PDF; charset=binary" },
					}),
			},
			{
				isEnabled: () => false,
				render: async () => null,
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/file.pdf",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.type).toBe("success");
		if (result.type !== "success") {
			throw new Error("Expected successful PDF fetch result");
		}
		expect(Buffer.isBuffer(result.content)).toBe(true);
		expect(result.content).toEqual(Buffer.from(pdfBytes));
		expect(result.contentLength).toBe(pdfBytes.byteLength);
	});

	test("measures dynamic contentLength from rendered DOM instead of renderer metadata", async () => {
		const content =
			"<html><body><main>This dynamic DOM is larger than the stale content-length metadata.</main></body></html>";
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: mock(async () => new Response("should not be called")),
			},
			{
				isEnabled: () => true,
				render: async () => ({
					type: "success",
					result: {
						isDynamic: true,
						content,
						statusCode: 200,
						contentType: "text/html",
						contentLength: 12,
						title: "Dynamic",
						description: "",
						lastModified: undefined,
						etag: '"dynamic-etag"',
						xRobotsTag: null,
					},
				}),
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/dynamic",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.type).toBe("success");
		if (result.type !== "success") {
			throw new Error("Expected successful dynamic fetch result");
		}
		expect(result.isDynamic).toBe(true);
		expect(result.contentLength).toBe(Buffer.byteLength(content, "utf8"));
		expect(result.etag).toBe('"dynamic-etag"');
	});
});
