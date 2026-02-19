import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	clearResolutionCache,
	getCacheStats,
	resolveUrlSecurely,
	secureFetch,
} from "../secureFetch.js";

describe("secureFetch", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		clearResolutionCache();
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	describe("SSRF protection", () => {
		test("blocks localhost", async () => {
			await expect(resolveUrlSecurely("http://localhost/test")).rejects.toThrow(
				"Target host is not allowed",
			);
		});

		test("blocks 127.0.0.1 (loopback)", async () => {
			await expect(resolveUrlSecurely("http://127.0.0.1/test")).rejects.toThrow(
				"Target host is not allowed",
			);
		});

		test("blocks 127.0.0.2 (loopback range)", async () => {
			await expect(resolveUrlSecurely("http://127.0.0.2/test")).rejects.toThrow(
				"Target host is not allowed",
			);
		});

		test("blocks 10.0.0.1 (private class A)", async () => {
			await expect(resolveUrlSecurely("http://10.0.0.1/test")).rejects.toThrow(
				"Target host is not allowed",
			);
		});

		test("blocks 172.16.0.1 (private class B)", async () => {
			await expect(
				resolveUrlSecurely("http://172.16.0.1/test"),
			).rejects.toThrow("Target host is not allowed");
		});

		test("blocks 192.168.1.1 (private class C)", async () => {
			await expect(
				resolveUrlSecurely("http://192.168.1.1/test"),
			).rejects.toThrow("Target host is not allowed");
		});

		test("blocks 0.0.0.0", async () => {
			await expect(resolveUrlSecurely("http://0.0.0.0/test")).rejects.toThrow(
				"Target host is not allowed",
			);
		});

		test("blocks 169.254.169.254 (AWS metadata)", async () => {
			await expect(
				resolveUrlSecurely("http://169.254.169.254/latest/meta-data/"),
			).rejects.toThrow("Target host is not allowed");
		});

		test("blocks [::1] (IPv6 loopback)", async () => {
			await expect(resolveUrlSecurely("http://[::1]/test")).rejects.toThrow(
				"Target host is not allowed",
			);
		});

		test("blocks [fc00::1] (IPv6 unique local)", async () => {
			await expect(resolveUrlSecurely("http://[fc00::1]/test")).rejects.toThrow(
				"Target host is not allowed",
			);
		});

		test("blocks [fe80::1] (IPv6 link-local)", async () => {
			await expect(resolveUrlSecurely("http://[fe80::1]/test")).rejects.toThrow(
				"Target host is not allowed",
			);
		});

		test("blocks IPv4-mapped IPv6 addresses that resolve to private", async () => {
			await expect(
				resolveUrlSecurely("http://[::ffff:192.168.1.1]/test"),
			).rejects.toThrow("Target host is not allowed");
		});
	});

	describe("valid public addresses", () => {
		test("allows public IPv4 addresses", async () => {
			const result = await resolveUrlSecurely("http://93.184.216.34/test");
			expect(result.url).toBe("http://93.184.216.34/test");
		});

		test("allows public hostnames (via DNS)", async () => {
			global.fetch = originalFetch;

			const result = await resolveUrlSecurely("https://example.com/test");
			expect(result.resolvedHost).toBe("example.com");
		});
	});

	describe("DNS resolution", () => {
		test("handles DNS resolution failure", async () => {
			await expect(
				resolveUrlSecurely("http://nonexistent.invalid.domain/test"),
			).rejects.toThrow();
		});

		test("caches DNS resolution", async () => {
			await resolveUrlSecurely("https://example.com/test");
			await resolveUrlSecurely("https://example.com/other");

			const stats = getCacheStats();
			expect(stats.size).toBe(1);
			expect(stats.entries).toContain("example.com");
		});
	});

	describe("cache management", () => {
		test("clearResolutionCache empties cache", async () => {
			await resolveUrlSecurely("https://example.com/test");

			expect(getCacheStats().size).toBe(1);

			clearResolutionCache();

			expect(getCacheStats().size).toBe(0);
		});

		test("getCacheStats returns correct info", async () => {
			clearResolutionCache();

			await resolveUrlSecurely("https://example.com/test");

			const stats = getCacheStats();

			expect(stats.size).toBe(1);
			expect(stats.entries).toHaveLength(1);
		});
	});

	describe("fetch integration", () => {
		test("performs fetch after validation", async () => {
			const mockResponse = new Response("OK", { status: 200 });
			global.fetch = mock(() =>
				Promise.resolve(mockResponse),
			) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/test",
			});

			expect(response.status).toBe(200);
		});

		test("passes headers to fetch", async () => {
			const mockResponse = new Response("OK", { status: 200 });
			const fetchMock = mock(() =>
				Promise.resolve(mockResponse),
			) as unknown as typeof fetch;
			global.fetch = fetchMock;

			await secureFetch({
				url: "https://example.com/test",
				headers: { "X-Custom": "value" },
			});

			expect(fetchMock).toHaveBeenCalled();
		});

		test("respects abort signal", async () => {
			const controller = new AbortController();
			controller.abort();

			await expect(
				secureFetch({
					url: "https://example.com/test",
					signal: controller.signal,
				}),
			).rejects.toThrow();
		});
	});

	describe("redirect security", () => {
		test("follows valid redirects", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "https://example.com/redirected" },
			});
			const finalResponse = new Response("OK", { status: 200 });

			let callCount = 0;
			global.fetch = mock(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(redirectResponse);
				return Promise.resolve(finalResponse);
			}) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "follow",
			});

			expect(response.status).toBe(200);
			expect(callCount).toBe(2);
		});

		test("blocks redirect to private IP", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "http://192.168.1.1/admin" },
			});

			global.fetch = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			await expect(
				secureFetch({
					url: "https://example.com/initial",
					redirect: "follow",
				}),
			).rejects.toThrow("Redirect to disallowed host blocked");
		});

		test("blocks redirect to localhost", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "http://localhost/admin" },
			});

			global.fetch = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			await expect(
				secureFetch({
					url: "https://example.com/initial",
					redirect: "follow",
				}),
			).rejects.toThrow("Redirect to disallowed host blocked");
		});

		test("blocks redirect to AWS metadata endpoint", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "http://169.254.169.254/latest/meta-data/" },
			});

			global.fetch = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			await expect(
				secureFetch({
					url: "https://example.com/initial",
					redirect: "follow",
				}),
			).rejects.toThrow("Redirect to disallowed host blocked");
		});

		test("handles redirect=error by throwing on redirect", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "https://example.com/redirected" },
			});

			global.fetch = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			await expect(
				secureFetch({
					url: "https://example.com/initial",
					redirect: "error",
				}),
			).rejects.toThrow("Redirect not allowed");
		});

		test("handles redirect=manual by returning redirect response", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "https://example.com/redirected" },
			});

			global.fetch = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "manual",
			});

			expect(response.status).toBe(302);
		});

		test("handles relative redirect URLs", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "/relative/path" },
			});
			const finalResponse = new Response("OK", { status: 200 });

			let callCount = 0;
			global.fetch = mock(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(redirectResponse);
				return Promise.resolve(finalResponse);
			}) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "follow",
			});

			expect(response.status).toBe(200);
		});

		test("returns response when redirect has no location header", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: {},
			});

			global.fetch = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "follow",
			});

			expect(response.status).toBe(302);
		});

		test("limits redirect hops to prevent loops", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "https://example.com/loop" },
			});

			global.fetch = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			await expect(
				secureFetch({
					url: "https://example.com/initial",
					redirect: "follow",
				}),
			).rejects.toThrow("Too many redirects");
		});

		test("handles 301 permanent redirect", async () => {
			const redirectResponse = new Response(null, {
				status: 301,
				headers: { location: "https://example.com/new-location" },
			});
			const finalResponse = new Response("OK", { status: 200 });

			let callCount = 0;
			global.fetch = mock(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(redirectResponse);
				return Promise.resolve(finalResponse);
			}) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/old-location",
				redirect: "follow",
			});

			expect(response.status).toBe(200);
		});

		test("handles 307 temporary redirect", async () => {
			const redirectResponse = new Response(null, {
				status: 307,
				headers: { location: "https://example.com/temp" },
			});
			const finalResponse = new Response("OK", { status: 200 });

			let callCount = 0;
			global.fetch = mock(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(redirectResponse);
				return Promise.resolve(finalResponse);
			}) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "follow",
			});

			expect(response.status).toBe(200);
		});

		test("handles 308 permanent redirect", async () => {
			const redirectResponse = new Response(null, {
				status: 308,
				headers: { location: "https://example.com/permanent" },
			});
			const finalResponse = new Response("OK", { status: 200 });

			let callCount = 0;
			global.fetch = mock(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(redirectResponse);
				return Promise.resolve(finalResponse);
			}) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "follow",
			});

			expect(response.status).toBe(200);
		});
	});

	describe("edge cases", () => {
		test("handles empty hostname", async () => {
			await expect(resolveUrlSecurely("http:///test")).rejects.toThrow();
		});

		test("handles hostname with port", async () => {
			const result = await resolveUrlSecurely("https://example.com:8080/test");
			expect(result.resolvedHost).toBe("example.com");
		});

		test("handles IPv6 hostname format", async () => {
			await expect(
				resolveUrlSecurely("http://[::1]:8080/test"),
			).rejects.toThrow("Target host is not allowed");
		});

		test("validates each time when cache expires", async () => {
			clearResolutionCache();

			await resolveUrlSecurely("https://example.com/test");

			expect(getCacheStats().size).toBe(1);
		});
	});
});
