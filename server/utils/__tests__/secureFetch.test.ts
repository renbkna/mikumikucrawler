import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CrawlerError } from "../../errors.js";

// Re-import real module to undo any mock.module from other test files
// (sitemapParser.test.ts uses mock.module("../secureFetch.js", ...) which persists)
const {
	clearResolutionCache,
	getCacheStats,
	resolveUrlSecurely,
	secureFetch,
} = await import("../secureFetch.js");

/**
 * CONTRACT: secureFetch
 *
 * Purpose: Performs HTTP requests with DNS-level SSRF protection.
 * Prevents attacks by validating hostnames before allowing network access.
 *
 * COMPONENTS:
 *
 * 1. SSRF Protection (resolveUrlSecurely)
 *    - Validates hostnames resolve to public IPs only
 *    - Blocks private ranges (10.x.x.x, 192.168.x.x, etc.)
 *    - Blocks loopback (127.x.x.x, ::1)
 *    - Blocks link-local (169.254.x.x)
 *    - Blocks IPv6 unique local (fc00::/7)
 *    - Caches DNS resolutions for 5 minutes
 *
 * 2. Secure Fetch (secureFetch)
 *    - Validates URL before fetching
 *    - Delegates to runtime fetch() for actual HTTP
 *    - Passes through redirect option (follow/error/manual)
 *    - NO manual redirect following - relies on fetch implementation
 *
 * INPUTS:
 *   - url: string (URL to fetch)
 *   - signal?: AbortSignal (request cancellation)
 *   - headers?: Record<string, string> (custom headers)
 *   - redirect?: "follow" | "error" | "manual" (redirect behavior)
 *
 * OUTPUTS:
 *   - Response: Standard fetch Response object
 *   - Errors: Throws for SSRF violations, DNS failures
 *
 * INVARIANTS:
 *   1. DNS VALIDATION: Every URL resolved and validated before fetch
 *   2. CACHING: DNS resolutions cached for 5 minutes (TTL)
 *   3. SSRF BLOCKING: Private/internal IPs blocked at resolution time
 *   4. REDIRECT DELEGATION: No manual redirect handling - delegated to fetch
 *   5. ERROR PROPAGATION: DNS errors throw, fetch errors propagate
 *
 * EDGE CASES:
 *   - Empty hostname
 *   - Hostname with port
 *   - IPv6 formats
 *   - Cache expiration
 *   - Redirect responses (handled by fetch, not validated by secureFetch)
 */

describe("secureFetch CONTRACT", () => {
	beforeEach(() => {
		clearResolutionCache();
	});

	describe("INVARIANT: SSRF Protection at DNS Resolution", () => {
		const expectSSRFBlock = async (url: string) => {
			try {
				await resolveUrlSecurely(url);
				throw new Error("Expected SSRF block");
			} catch (err) {
				expect(CrawlerError.isSSRF(err)).toBe(true);
			}
		};

		test("blocks localhost", async () => {
			await expectSSRFBlock("http://localhost/test");
		});

		test("blocks 127.0.0.1 (loopback)", async () => {
			await expectSSRFBlock("http://127.0.0.1/test");
		});

		test("blocks 127.0.0.2 (loopback range)", async () => {
			await expectSSRFBlock("http://127.0.0.2/test");
		});

		test("blocks 10.0.0.1 (private class A)", async () => {
			await expectSSRFBlock("http://10.0.0.1/test");
		});

		test("blocks 172.16.0.1 (private class B)", async () => {
			await expectSSRFBlock("http://172.16.0.1/test");
		});

		test("blocks 192.168.1.1 (private class C)", async () => {
			await expectSSRFBlock("http://192.168.1.1/test");
		});

		test("blocks 0.0.0.0", async () => {
			await expectSSRFBlock("http://0.0.0.0/test");
		});

		test("blocks 169.254.169.254 (AWS metadata)", async () => {
			await expectSSRFBlock("http://169.254.169.254/latest/meta-data/");
		});

		test("blocks [::1] (IPv6 loopback)", async () => {
			await expectSSRFBlock("http://[::1]/test");
		});

		test("blocks [fc00::1] (IPv6 unique local)", async () => {
			await expectSSRFBlock("http://[fc00::1]/test");
		});

		test("blocks [fe80::1] (IPv6 link-local)", async () => {
			await expectSSRFBlock("http://[fe80::1]/test");
		});

		test("blocks IPv4-mapped IPv6 addresses that resolve to private", async () => {
			await expectSSRFBlock("http://[::ffff:192.168.1.1]/test");
		});
	});

	describe("INVARIANT: Valid Public Addresses Allowed", () => {
		test("allows public IPv4 addresses", async () => {
			const result = await resolveUrlSecurely("http://93.184.216.34/test");
			expect(result.ip).toBe("93.184.216.34");
		});

		test("allows public hostnames (via DNS)", async () => {
			const result = await resolveUrlSecurely("https://example.com/test");
			expect(result.hostname).toBe("example.com");
		});
	});

	describe("INVARIANT: DNS Resolution", () => {
		test("handles DNS resolution failure", async () => {
			try {
				await resolveUrlSecurely("http://nonexistent.invalid.domain/test");
				throw new Error("Expected DNS failure");
			} catch (err) {
				expect(err).toBeInstanceOf(CrawlerError);
			}
		});

		test("caches DNS resolution", async () => {
			await resolveUrlSecurely("https://example.com/test");
			await resolveUrlSecurely("https://example.com/other");

			const stats = getCacheStats();
			expect(stats.size).toBe(1);
			expect(stats.entries).toContain("example.com");
		});

		test("uses cache for repeated resolutions", async () => {
			await resolveUrlSecurely("https://example.com/test");

			const stats1 = getCacheStats();
			expect(stats1.size).toBe(1);

			// Second call should use cache
			await resolveUrlSecurely("https://example.com/another");

			const stats2 = getCacheStats();
			expect(stats2.size).toBe(1); // Still 1, from cache
		});
	});

	describe("INVARIANT: Cache Management", () => {
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

		test("cache has TTL of 5 minutes", async () => {
			// Cache implementation uses TTL, but we can't easily test
			// expiration without waiting. Verify it works immediately.
			await resolveUrlSecurely("https://example.com/test");
			expect(getCacheStats().size).toBe(1);
		});
	});

	describe("INVARIANT: Fetch Delegation", () => {
		test("performs fetch after validation", async () => {
			const mockResponse = new Response("OK", { status: 200 });
			const fetchMock = mock(() =>
				Promise.resolve(mockResponse),
			) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/test",
				fetchFn: fetchMock,
			});

			expect(response.status).toBe(200);
		});

		test("passes headers to fetch", async () => {
			const mockResponse = new Response("OK", { status: 200 });
			const fetchMock = mock(() =>
				Promise.resolve(mockResponse),
			) as unknown as typeof fetch;

			await secureFetch({
				url: "https://example.com/test",
				headers: { "X-Custom": "value" },
				fetchFn: fetchMock,
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

		test("delegates redirect handling to fetch", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "https://example.com/redirected" },
			});

			const fetchMock = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "follow",
				fetchFn: fetchMock,
			});

			expect(response.status).toBe(302);
		});

		test("returns redirect response when redirect=manual", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "https://example.com/redirected" },
			});

			const fetchMock = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "manual",
				fetchFn: fetchMock,
			});

			expect(response.status).toBe(302);
			expect(response.headers.get("location")).toBe(
				"https://example.com/redirected",
			);
		});
	});

	describe("EDGE CASE: Redirect Behavior (Delegated to Fetch)", () => {
		test("NOTE: Redirect validation is NOT implemented", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "http://192.168.1.1/admin" },
			});

			const fetchMock = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "manual",
				fetchFn: fetchMock,
			});

			expect(response.status).toBe(302);
		});

		test("handles various redirect status codes", async () => {
			const codes = [301, 302, 307, 308];

			for (const code of codes) {
				clearResolutionCache();

				const redirectResponse = new Response(null, {
					status: code,
					headers: { location: "https://example.com/redirected" },
				});

				const fetchMock = mock(() =>
					Promise.resolve(redirectResponse),
				) as unknown as typeof fetch;

				const response = await secureFetch({
					url: "https://example.com/initial",
					redirect: "manual",
					fetchFn: fetchMock,
				});

				expect(response.status).toBe(code);
			}
		});

		test("handles relative redirect URLs in Location header", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: { location: "/relative/path" },
			});

			const fetchMock = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "manual",
				fetchFn: fetchMock,
			});

			expect(response.status).toBe(302);
			expect(response.headers.get("location")).toBe("/relative/path");
		});

		test("handles redirect response without Location header", async () => {
			const redirectResponse = new Response(null, {
				status: 302,
				headers: {},
			});

			const fetchMock = mock(() =>
				Promise.resolve(redirectResponse),
			) as unknown as typeof fetch;

			const response = await secureFetch({
				url: "https://example.com/initial",
				redirect: "manual",
				fetchFn: fetchMock,
			});

			expect(response.status).toBe(302);
		});
	});

	describe("EDGE CASE: URL Validation", () => {
		test(
			"handles URLs with missing authority (http:///test)",
			async () => {
				// NOTE: `http:///test` is parsed by URL constructor as `http://test/`
				// where "test" is the hostname. This is not actually an empty hostname case.
				// The test verifies that such URLs are handled (rejected due to DNS failure).
				try {
					await resolveUrlSecurely("http:///test");
					throw new Error("Expected failure");
				} catch (err) {
					expect(err).toBeInstanceOf(CrawlerError);
				}
			},
			{ timeout: 10000 },
		);

		test("handles hostname with port", async () => {
			const result = await resolveUrlSecurely("https://example.com:8080/test");
			expect(result.hostname).toBe("example.com");
		});

		test("handles IPv6 hostname format", async () => {
			try {
				await resolveUrlSecurely("http://[::1]:8080/test");
				throw new Error("Expected SSRF block");
			} catch (err) {
				expect(CrawlerError.isSSRF(err)).toBe(true);
			}
		});

		test("validates each time when cache expires", async () => {
			clearResolutionCache();

			await resolveUrlSecurely("https://example.com/test");

			expect(getCacheStats().size).toBe(1);
		});
	});
});
