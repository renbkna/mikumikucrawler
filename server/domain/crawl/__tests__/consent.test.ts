import { describe, expect, test } from "bun:test";
import {
	isConsentActionText,
	isConsentWallText,
	requiresStrictConsentBypass,
} from "../consent.js";

describe("consent heuristics contract", () => {
	test("detects english and german consent walls", () => {
		expect(isConsentWallText("Before you continue to YouTube")).toBe(true);
		expect(
			isConsentWallText("Bevor Sie fortfahren, akzeptieren Sie Cookies"),
		).toBe(true);
	});

	test("matches localized accept actions", () => {
		expect(isConsentActionText("Accept all")).toBe(true);
		expect(isConsentActionText("Alle akzeptieren")).toBe(true);
		expect(isConsentActionText("Zustimmen und fortfahren")).toBe(true);
	});

	test("requires strict consent bypass for youtube domains only", () => {
		expect(
			requiresStrictConsentBypass(
				"https://www.youtube.com/watch?v=fidFUKnRGNQ&t=1139s",
			),
		).toBe(true);
		expect(
			requiresStrictConsentBypass("https://m.youtube.com/watch?v=fidFUKnRGNQ"),
		).toBe(true);
		expect(
			requiresStrictConsentBypass("https://example.com/watch?v=test"),
		).toBe(false);
	});
});
