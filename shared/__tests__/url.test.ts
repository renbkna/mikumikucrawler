import { describe, expect, test } from "bun:test";
import { MAX_URL_LENGTH, normalizeCanonicalHttpUrl, normalizeRobotsMatchHttpUrl } from "../url.js";

function urlOfLength(length: number): string {
	const prefix = "https://example.com/";
	return `${prefix}${"a".repeat(length - prefix.length)}`;
}

describe("shared URL resource boundary", () => {
	test("accepts the configured maximum and rejects one character more before parsing", () => {
		const maximum = urlOfLength(MAX_URL_LENGTH);
		const oversized = urlOfLength(MAX_URL_LENGTH + 1);

		expect(normalizeCanonicalHttpUrl(maximum)).toHaveProperty("url");
		expect(normalizeCanonicalHttpUrl(oversized)).toEqual({
			error: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters`,
		});
	});

	test("applies the same bound to robots-match URL identity", () => {
		expect(normalizeRobotsMatchHttpUrl(urlOfLength(MAX_URL_LENGTH + 1))).toEqual({
			error: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters`,
		});
	});
});
