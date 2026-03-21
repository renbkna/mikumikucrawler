import { describe, expect, test } from "bun:test";
import { normalizeHttpUrl } from "../../../shared/url";

describe("normalizeHttpUrl", () => {
	test("canonicalizes user-entered http urls for both frontend and backend", () => {
		expect(
			normalizeHttpUrl(
				" Example.COM:80/path/?b=2&utm_source=newsletter&a=1#section ",
			),
		).toEqual({
			url: "http://example.com/path/?a=1&b=2",
		});
	});

	test("rejects non-http schemes explicitly", () => {
		expect(normalizeHttpUrl("mailto:test@example.com")).toEqual({
			error: "Only HTTP and HTTPS URLs are supported",
		});
	});
});
