import { describe, expect, test } from "bun:test";
import {
	isConsentWallText,
	isUnresolvedStrictConsentWall,
	requiresStrictConsentBypass,
} from "../consent.js";

describe("consent heuristics contract", () => {
	test("detects english and german consent walls", () => {
		expect(isConsentWallText("Before you continue to YouTube")).toBe(true);
		expect(isConsentWallText("Bevor Sie fortfahren, akzeptieren Sie Cookies")).toBe(true);
	});

	test("requires strict consent bypass for youtube domains only", () => {
		expect(requiresStrictConsentBypass("https://www.youtube.com/watch?v=fidFUKnRGNQ&t=1139s")).toBe(
			true,
		);
		expect(requiresStrictConsentBypass("https://m.youtube.com/watch?v=fidFUKnRGNQ")).toBe(true);
		expect(requiresStrictConsentBypass("https://example.com/watch?v=test")).toBe(false);
	});

	test("uses the final document URL when redirects change consent policy", () => {
		const unresolved = { detected: true, bypassed: false };
		expect(isUnresolvedStrictConsentWall(unresolved, "https://youtube.com/watch?v=1")).toBe(true);
		expect(isUnresolvedStrictConsentWall(unresolved, "https://example.com/watch?v=1")).toBe(false);
		expect(
			isUnresolvedStrictConsentWall({ detected: true, bypassed: true }, "https://youtube.com/"),
		).toBe(false);
	});
});
