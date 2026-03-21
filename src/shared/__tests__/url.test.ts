import { describe, expect, test } from "bun:test";
import { normalizeHttpUrl } from "../../../shared/url";

/**
 * CONTRACT: normalizeHttpUrl
 *
 * Input: user-entered or discovered URL text
 * Output: { url: string } | { error: string }
 *
 * Invariants:
 *   - lowercase hostname
 *   - no fragment
 *   - default ports removed (80 for http, 443 for https)
 *   - tracking/session params stripped (utm_*, fbclid, gclid, etc.)
 *   - query params sorted alphabetically
 *   - trailing slash trimmed (except root path)
 *   - bare hostnames get http:// prepended
 *
 * Forbidden states:
 *   - non-HTTP(S) schemes → error
 *   - unparsable URLs → error
 *   - empty/null input → error
 */

describe("normalizeHttpUrl", () => {
	test("canonical normalization: lowercase, port strip, param sort, tracking strip, fragment strip", () => {
		expect(
			normalizeHttpUrl(
				" Example.COM:80/path/?b=2&utm_source=newsletter&a=1#section ",
			),
		).toEqual({
			url: "http://example.com/path/?a=1&b=2",
		});
	});

	test("strips fragment from URLs", () => {
		expect(normalizeHttpUrl("https://example.com/page#section")).toEqual({
			url: "https://example.com/page",
		});
	});

	test("removes default port 80 for http", () => {
		expect(normalizeHttpUrl("http://example.com:80/path")).toEqual({
			url: "http://example.com/path",
		});
	});

	test("removes default port 443 for https", () => {
		expect(normalizeHttpUrl("https://example.com:443/path")).toEqual({
			url: "https://example.com/path",
		});
	});

	test("preserves non-default ports", () => {
		expect(normalizeHttpUrl("http://example.com:8080/path")).toEqual({
			url: "http://example.com:8080/path",
		});
	});

	test("prepends http:// for bare hostnames", () => {
		const result = normalizeHttpUrl("example.com/page");
		expect(result).toEqual({ url: "http://example.com/page" });
	});

	test("trims trailing slash except for root path", () => {
		expect(normalizeHttpUrl("https://example.com/path/")).toEqual({
			url: "https://example.com/path",
		});
		// Root path keeps its slash
		expect(normalizeHttpUrl("https://example.com/")).toEqual({
			url: "https://example.com/",
		});
	});

	test("strips tracking params (utm_*, fbclid, gclid)", () => {
		expect(
			normalizeHttpUrl(
				"https://example.com/page?q=search&utm_medium=email&fbclid=abc&gclid=def",
			),
		).toEqual({
			url: "https://example.com/page?q=search",
		});
	});

	test("rejects non-http schemes", () => {
		expect(normalizeHttpUrl("mailto:test@example.com")).toEqual({
			error: "Only HTTP and HTTPS URLs are supported",
		});
		expect(normalizeHttpUrl("ftp://files.example.com")).toEqual({
			error: "Only HTTP and HTTPS URLs are supported",
		});
	});

	test("rejects empty input", () => {
		expect(normalizeHttpUrl("")).toEqual({ error: "URL is required" });
	});

	test("rejects unparsable URLs", () => {
		expect(normalizeHttpUrl("http://[invalid")).toEqual({
			error: "Invalid URL format",
		});
	});
});
