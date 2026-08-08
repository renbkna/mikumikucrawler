import { describe, expect, test } from "bun:test";
import { analyzeContent } from "../analysisUtils.js";

describe("content analysis", () => {
	test("derives the three page metrics consumed by recovery and the UI", () => {
		expect(analyzeContent("   ")).toEqual({
			wordCount: 0,
			readingTime: 0,
			language: "unknown",
		});

		const result = analyzeContent(
			"English is a West Germanic language in the Indo-European language family, whose speakers, called Anglophones, originated in early medieval England. The namesake of the language is the Angles, one of the ancient Germanic peoples that migrated to the island of Great Britain.",
		);
		expect(result).toEqual({
			wordCount: 42,
			readingTime: 1,
			language: "en",
		});
	});
});
