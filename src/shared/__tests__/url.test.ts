import { describe, expect, test } from "bun:test";
import {
	normalizeCanonicalHttpUrl,
	normalizeRobotsMatchHttpUrl,
	validatePublicHttpUrl,
} from "../../../shared/url";

/**
 * CONTRACT: normalizeCanonicalHttpUrl
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

describe("normalizeCanonicalHttpUrl", () => {
	test("canonical normalization: lowercase, port strip, param sort, tracking strip, fragment strip", () => {
		expect(
			normalizeCanonicalHttpUrl(
				" Example.COM:80/path/?b=2&utm_source=newsletter&a=1#section ",
			),
		).toEqual({
			url: "http://example.com/path/?a=1&b=2",
		});
	});

	test("strips fragment from URLs", () => {
		expect(
			normalizeCanonicalHttpUrl("https://example.com/page#section"),
		).toEqual({ url: "https://example.com/page" });
	});

	test("removes default port 80 for http", () => {
		expect(normalizeCanonicalHttpUrl("http://example.com:80/path")).toEqual({
			url: "http://example.com/path",
		});
	});

	test("removes default port 443 for https", () => {
		expect(normalizeCanonicalHttpUrl("https://example.com:443/path")).toEqual({
			url: "https://example.com/path",
		});
	});

	test("preserves non-default ports", () => {
		expect(normalizeCanonicalHttpUrl("http://example.com:8080/path")).toEqual({
			url: "http://example.com:8080/path",
		});
	});

	test("prepends http:// for bare hostnames", () => {
		const result = normalizeCanonicalHttpUrl("example.com/page");
		expect(result).toEqual({ url: "http://example.com/page" });
	});

	test("trims trailing slash except for root path", () => {
		expect(normalizeCanonicalHttpUrl("https://example.com/path/")).toEqual({
			url: "https://example.com/path",
		});
		// Root path keeps its slash
		expect(normalizeCanonicalHttpUrl("https://example.com/")).toEqual({
			url: "https://example.com/",
		});
	});

	test("strips tracking params (utm_*, fbclid, gclid)", () => {
		expect(
			normalizeCanonicalHttpUrl(
				"https://example.com/page?q=search&utm_medium=email&fbclid=abc&gclid=def",
			),
		).toEqual({
			url: "https://example.com/page?q=search",
		});
	});

	test("rejects non-http schemes", () => {
		expect(normalizeCanonicalHttpUrl("mailto:test@example.com")).toEqual({
			error: "Only HTTP and HTTPS URLs are supported",
		});
		expect(normalizeCanonicalHttpUrl("ftp://files.example.com")).toEqual({
			error: "Only HTTP and HTTPS URLs are supported",
		});
	});

	test("rejects empty input", () => {
		expect(normalizeCanonicalHttpUrl("")).toEqual({
			error: "URL is required",
		});
	});

	test("rejects unparsable URLs", () => {
		expect(normalizeCanonicalHttpUrl("http://[invalid")).toEqual({
			error: "Invalid URL format",
		});
	});
});

describe("normalizeRobotsMatchHttpUrl", () => {
	test("shares parse invariants but preserves query shape for robots matching", () => {
		expect(
			normalizeRobotsMatchHttpUrl(
				"HTTPS://Example.COM:443/path/?b=2&a=1&utm_source=x#section",
			),
		).toEqual({
			url: "https://example.com/path/?b=2&a=1&utm_source=x",
		});
	});

	test("preserves trailing slash and non-default ports", () => {
		expect(
			normalizeRobotsMatchHttpUrl("http://Example.COM:8080/path/?b=2&a=1"),
		).toEqual({ url: "http://example.com:8080/path/?b=2&a=1" });
	});

	test("rejects the same forbidden schemes as canonical mode", () => {
		expect(normalizeRobotsMatchHttpUrl("javascript:void(0)")).toEqual({
			error: "Only HTTP and HTTPS URLs are supported",
		});
	});
});

describe("validatePublicHttpUrl", () => {
	test("accepts normal DNS hostnames", () => {
		expect(validatePublicHttpUrl("https://example.com/page")).toEqual({
			url: "https://example.com/page",
		});
		expect(validatePublicHttpUrl("example.com/path")).toEqual({
			url: "http://example.com/path",
		});
	});

	test("rejects localhost, private IP, and IPv4-mapped private literals", () => {
		expect(validatePublicHttpUrl("http://localhost")).toEqual({
			error: "Localhost targets are not allowed",
		});
		expect(validatePublicHttpUrl("http://127.0.0.1")).toEqual({
			error: "Private or reserved IP addresses are not allowed",
		});
		expect(validatePublicHttpUrl("http://[::ffff:127.0.0.1]")).toEqual({
			error: "Private or reserved IP addresses are not allowed",
		});
	});
});
