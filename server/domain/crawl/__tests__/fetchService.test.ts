import { describe, expect, mock, test } from "bun:test";
import { config } from "../../../config/env.js";
import type { Logger } from "../../../config/logging.js";
import { REQUEST_CONSTANTS } from "../../../constants.js";
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
					message: "Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
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
			reason: "Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
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

	test("maps transient browser-rendered HTTP errors to retryable failures", async () => {
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
			type: "transientFailure",
			statusCode: 500,
		});
	});

	test("maps transient static HTTP errors to retryable failures", async () => {
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
			type: "transientFailure",
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

	test("leaves missing rate-limit retry fallback to the pipeline", async () => {
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: async () => new Response("", { status: 429 }),
			},
			{
				isEnabled: () => false,
				render: async () => null,
			} as never,
			createLogger(),
		);

		await expect(
			service.fetch("crawl-1", {
				url: "https://example.com/rate-limited",
				domain: "example.com",
				depth: 0,
				retries: 0,
			}),
		).resolves.toEqual({
			type: "rateLimited",
			statusCode: 429,
			retryAfterMs: undefined,
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

	test("uses static bytes for supported non-HTML representations", async () => {
		const httpFetch = mock(
			async () =>
				new Response('{"source":"raw-json"}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const service = new FetchService(
			{ getHeaders: () => null } as never,
			{ fetch: httpFetch },
			{
				isEnabled: () => true,
				render: async () => ({ type: "staticFallback", reason: "non-html" }),
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/data",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toMatchObject({
			type: "success",
			content: '{"source":"raw-json"}',
			contentType: "application/json",
			isDynamic: false,
		});
	});

	test("does not replay dynamic document transport failures through static fetch", async () => {
		const httpFetch = mock(async () => new Response("must not run"));
		const service = new FetchService(
			{ getHeaders: () => null } as never,
			{ fetch: httpFetch },
			{
				isEnabled: () => true,
				render: async () => ({ type: "transportFailure", message: "connection reset" }),
			} as never,
			createLogger(),
		);

		await expect(
			service.fetch("crawl-1", {
				url: "https://example.com/failure",
				domain: "example.com",
				depth: 0,
				retries: 0,
			}),
		).resolves.toEqual({
			type: "transientFailure",
			statusCode: 0,
			retryAfterMs: 1000,
		});
		expect(httpFetch).not.toHaveBeenCalled();
	});

	test("does not retry oversized dynamic documents through static fetch", async () => {
		const httpFetch = mock(async () => new Response("must not run"));
		const service = new FetchService(
			{ getHeaders: () => null } as never,
			{ fetch: httpFetch },
			{
				isEnabled: () => true,
				render: async () => ({ type: "tooLarge" }),
			} as never,
			createLogger(),
		);

		await expect(
			service.fetch("crawl-1", {
				url: "https://example.com/huge",
				domain: "example.com",
				depth: 0,
				retries: 0,
			}),
		).resolves.toEqual({
			type: "blocked",
			statusCode: 413,
			reason: "Response too large for https://example.com/huge",
		});
		expect(httpFetch).not.toHaveBeenCalled();
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
		const httpFetch = mock(async (request: { headers?: Record<string, string> }) => {
			seenHeaders.push(request.headers);
			return new Response("<html><main>OK</main></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		});
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

	test("rejects unsupported static response types before buffering", async () => {
		let bodyRead = false;
		const response = new Response("installer bytes", {
			status: 200,
			headers: { "content-type": "application/x-msdownload" },
		});
		response.arrayBuffer = async () => {
			bodyRead = true;
			return new ArrayBuffer(0);
		};
		const service = new FetchService(
			{ getHeaders: () => null } as never,
			{ fetch: async () => response },
			{ isEnabled: () => false, render: async () => null } as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/download",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			type: "unsupported",
			statusCode: 200,
			contentType: "application/x-msdownload",
		});
		expect(bodyRead).toBe(false);
	});

	test("rejects unsupported dynamic response types", async () => {
		const httpFetch = mock(async () => new Response("should not be called"));
		const service = new FetchService(
			{ getHeaders: () => null } as never,
			{ fetch: httpFetch },
			{
				isEnabled: () => true,
				render: async () => ({
					type: "unsupported",
					statusCode: 200,
					contentType: "application/octet-stream",
				}),
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/download",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			type: "unsupported",
			statusCode: 200,
			contentType: "application/octet-stream",
		});
		expect(httpFetch).not.toHaveBeenCalled();
	});

	test("rejects declared oversized static responses before buffering", async () => {
		let textRead = false;
		const response = new Response("unused", {
			status: 200,
			headers: {
				"content-type": "text/html",
				"content-length": String(REQUEST_CONSTANTS.MAX_RESPONSE_BYTES + 1),
			},
		});
		response.text = async () => {
			textRead = true;
			return "unused";
		};
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: async () => response,
			},
			{
				isEnabled: () => false,
				render: async () => null,
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/too-large",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toMatchObject({
			type: "blocked",
			statusCode: 413,
		});
		expect(textRead).toBe(false);
	});

	test("classifies thrown static fetches as retryable transient failures", async () => {
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: async () => {
					throw new Error("socket reset");
				},
			},
			{
				isEnabled: () => false,
				render: async () => null,
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/socket-reset",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toMatchObject({
			type: "transientFailure",
			statusCode: 0,
		});
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

	test("carries the effective URL from static and dynamic acquisition", async () => {
		const staticResponse = new Response("<html><main>redirected</main></html>", {
			headers: { "content-type": "text/html" },
		});
		Object.defineProperty(staticResponse, "url", { value: "https://final.example/docs/" });
		const staticService = new FetchService(
			{ getHeaders: () => null } as never,
			{ fetch: async () => staticResponse },
			{ isEnabled: () => false, render: async () => null } as never,
			createLogger(),
		);
		const dynamicService = new FetchService(
			{ getHeaders: () => null } as never,
			{ fetch: mock(async () => new Response("unused")) },
			{
				isEnabled: () => true,
				render: async () => ({
					type: "success",
					result: {
						isDynamic: true,
						content: "<html><main>dynamic</main></html>",
						effectiveUrl: "https://dynamic.example/final/",
						statusCode: 200,
						contentType: "text/html",
						contentLength: 33,
						title: "",
						description: "",
						xRobotsTag: null,
					},
				}),
			} as never,
			createLogger(),
		);
		const item = {
			url: "https://example.com/start",
			domain: "example.com",
			depth: 0,
			retries: 0,
		};

		await expect(staticService.fetch("crawl-1", item)).resolves.toMatchObject({
			type: "success",
			effectiveUrl: "https://final.example/docs/",
		});
		await expect(dynamicService.fetch("crawl-1", item)).resolves.toMatchObject({
			type: "success",
			effectiveUrl: "https://dynamic.example/final/",
		});
	});

	test("refetches one unconditional time when 304 has no cached page", async () => {
		const requests: Array<{ headers?: Record<string, string> }> = [];
		const fetch = mock(async (request: { headers?: Record<string, string> }) => {
			requests.push(request);
			return fetch.mock.calls.length === 1
				? new Response(null, { status: 304 })
				: new Response("<html><main>fresh</main></html>", {
						headers: { "content-type": "text/html" },
					});
		});
		const service = new FetchService(
			{ getHeaders: () => null } as never,
			{ fetch },
			{ isEnabled: () => false, render: async () => null } as never,
			createLogger(),
		);

		await expect(
			service.fetch("crawl-1", {
				url: "https://example.com/first",
				domain: "example.com",
				depth: 0,
				retries: 0,
			}),
		).resolves.toMatchObject({ type: "success" });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(requests[1]?.headers).not.toHaveProperty("If-None-Match");
		expect(requests[1]?.headers).not.toHaveProperty("If-Modified-Since");
	});

	test("classifies repeated cacheless 304 as failure instead of page success", async () => {
		const fetch = mock(async () => new Response(null, { status: 304 }));
		const service = new FetchService(
			{ getHeaders: () => null } as never,
			{ fetch },
			{ isEnabled: () => false, render: async () => null } as never,
			createLogger(),
		);

		await expect(
			service.fetch("crawl-1", {
				url: "https://example.com/first",
				domain: "example.com",
				depth: 0,
				retries: 0,
			}),
		).resolves.toMatchObject({
			type: "blocked",
			statusCode: 304,
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("cancels classified error response bodies", async () => {
		let canceled = false;
		const service = new FetchService(
			{ getHeaders: () => null } as never,
			{
				fetch: async () =>
					new Response(
						new ReadableStream({
							cancel() {
								canceled = true;
							},
						}),
						{ status: 500 },
					),
			},
			{ isEnabled: () => false, render: async () => null } as never,
			createLogger(),
		);

		await service.fetch("crawl-1", {
			url: "https://example.com/error",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(canceled).toBe(true);
	});

	test("grants local networking only to the configured seed identity", async () => {
		const requests: Array<{ allowLocalhostOnInitialRequest?: boolean }> = [];
		const service = new FetchService(
			{ getHeaders: () => null } as never,
			{
				fetch: async (request) => {
					requests.push(request);
					return new Response("<html><main>local</main></html>", {
						headers: { "content-type": "text/html" },
					});
				},
			},
			{ isEnabled: () => false, render: async () => null } as never,
			createLogger(),
			"http://localhost:3000/",
		);

		await service.fetch("crawl-1", {
			url: "http://localhost:3000/",
			domain: "localhost",
			depth: 0,
			retries: 0,
		});
		await service.fetch("crawl-1", {
			url: "http://localhost:3000/child",
			domain: "localhost",
			depth: 0,
			retries: 0,
		});

		expect(requests[0]?.allowLocalhostOnInitialRequest).toBe(true);
		expect(requests[1]?.allowLocalhostOnInitialRequest).toBe(false);
	});
});
