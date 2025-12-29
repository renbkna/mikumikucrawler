import { describe, expect, test } from "bun:test";
import { analyzeContent, processJSON } from "../analysisUtils.js";

describe("analyzeContent", () => {
	test("produces keyword and sentiment insights", () => {
		const sample =
			"This article is amazing and wonderful. I love the great insights it provides.";
		const analysis = analyzeContent(sample);

		expect(analysis.sentiment).toBe("positive");
		expect(analysis.wordCount).toBeGreaterThan(0);
		expect(Array.isArray(analysis.keywords)).toBe(true);
		expect(analysis.keywords.length).toBeGreaterThan(0);
	});
});

describe("processJSON", () => {
	test("parses valid payloads", () => {
		const payload = '{"items":[{"name":"miku"},{"name":"rin"}] }';
		const result = processJSON(payload);

		expect(result.keys?.includes("items")).toBe(true);
		expect(result.structure).toContain("Object with 1 keys");
	});

	test("reports invalid payloads", () => {
		const result = processJSON("{not-valid");
		expect(result.error).toBe("Invalid JSON");
	});
});
