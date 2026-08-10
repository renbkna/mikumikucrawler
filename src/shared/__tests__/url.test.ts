import { describe, expect, test } from "bun:test";
import {
	MAX_URL_LENGTH,
	normalizeCanonicalHttpUrl,
	validatePublicHttpUrl,
} from "../../../shared/url";

function urlOfLength(length: number): string {
	const prefix = "https://example.com/";
	return `${prefix}${"a".repeat(length - prefix.length)}`;
}

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
 *   - one terminal DNS dot removed
 *   - fetch-significant path and query shape preserved
 *   - bare hostnames get http:// prepended
 *
 * Forbidden states:
 *   - non-HTTP(S) schemes → error
 *   - unparsable URLs → error
 *   - empty/null input → error
 */

describe("normalizeCanonicalHttpUrl", () => {
	test("normalizes transport syntax without rewriting fetch semantics", () => {
		expect(
			normalizeCanonicalHttpUrl(" Example.COM:80/path/?b=2&utm_source=newsletter&a=1#section "),
		).toEqual({
			url: "http://example.com/path/?b=2&utm_source=newsletter&a=1",
		});
	});

	test("strips fragment from URLs", () => {
		expect(normalizeCanonicalHttpUrl("https://example.com/page#section")).toEqual({
			url: "https://example.com/page",
		});
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

	test("preserves trailing slashes including non-root paths", () => {
		expect(normalizeCanonicalHttpUrl("https://example.com/path/")).toEqual({
			url: "https://example.com/path/",
		});
		// Root path keeps its slash
		expect(normalizeCanonicalHttpUrl("https://example.com/")).toEqual({
			url: "https://example.com/",
		});
	});

	test("preserves the path slash and query values ending in a slash", () => {
		expect(normalizeCanonicalHttpUrl("https://example.com/redirect?next=/")).toEqual({
			url: "https://example.com/redirect?next=/",
		});
		expect(normalizeCanonicalHttpUrl("https://example.com/path/?next=/")).toEqual({
			url: "https://example.com/path/?next=/",
		});
	});

	test("preserves query order and duplicate order", () => {
		expect(normalizeCanonicalHttpUrl("https://example.com/?ä=2&z=1&a=first&a=second")).toEqual({
			url: "https://example.com/?%C3%A4=2&z=1&a=first&a=second",
		});
	});

	test("preserves parameters whose meaning belongs to the origin", () => {
		expect(
			normalizeCanonicalHttpUrl(
				"https://example.com/page/?q=search&utm_medium=email&sessionid=abc",
			),
		).toEqual({
			url: "https://example.com/page/?q=search&utm_medium=email&sessionid=abc",
		});
	});

	test("preserves URL userinfo", () => {
		expect(normalizeCanonicalHttpUrl("https://user:secret@example.com/private")).toEqual({
			url: "https://user:secret@example.com/private",
		});
	});

	test("collapses a DNS trailing-dot alias", () => {
		expect(normalizeCanonicalHttpUrl("https://Example.COM./path")).toEqual({
			url: "https://example.com/path",
		});
	});

	test("rejects non-http schemes", () => {
		expect(normalizeCanonicalHttpUrl("mailto:test@example.com")).toEqual({
			error: "Only HTTP and HTTPS URLs are supported",
		});
		expect(normalizeCanonicalHttpUrl("ftp://files.example.com")).toEqual({
			error: "Only HTTP and HTTPS URLs are supported",
		});
		expect(normalizeCanonicalHttpUrl("ftp:123")).toEqual({
			error: "Only HTTP and HTTPS URLs are supported",
		});
	});

	test("accepts deliberate dotted-host and localhost ports without a scheme", () => {
		expect(normalizeCanonicalHttpUrl("example.com:8080/path")).toEqual({
			url: "http://example.com:8080/path",
		});
		expect(normalizeCanonicalHttpUrl("localhost:3000/path")).toEqual({
			url: "http://localhost:3000/path",
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

	test("accepts the maximum length and rejects one character more", () => {
		expect(normalizeCanonicalHttpUrl(urlOfLength(MAX_URL_LENGTH))).toHaveProperty("url");
		expect(normalizeCanonicalHttpUrl(urlOfLength(MAX_URL_LENGTH + 1))).toEqual({
			error: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters`,
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

	test("rejects localhost by default, allows it with allowLocalhost option", () => {
		expect(validatePublicHttpUrl("http://localhost")).toEqual({
			error: "Localhost targets are not allowed",
		});
		expect(validatePublicHttpUrl("http://localhost", { allowLocalhost: true })).toEqual({
			url: "http://localhost/",
		});
	});

	test("rejects private IP and IPv4-mapped private literals regardless of allowLocalhost", () => {
		expect(validatePublicHttpUrl("http://127.0.0.1")).toEqual({
			error: "Private or reserved IP addresses are not allowed",
		});
		expect(validatePublicHttpUrl("http://[::ffff:127.0.0.1]")).toEqual({
			error: "Private or reserved IP addresses are not allowed",
		});
	});
});
