import { describe, expect, test } from "bun:test";
import { analyzeContent, processJSON } from "../analysisUtils.js";

/**
 * CONTRACT: analyzeContent
 *
 * Input: text string
 * Output: { wordCount, readingTime, language, keywords[], sentiment, readabilityScore, quality }
 *
 * Key invariants:
 *   - keywords: max 10, sorted by count desc, stop words excluded, case-insensitive
 *   - readingTime: ceil(wordCount / 200), minimum 1 for non-empty
 *   - readabilityScore: clamped Flesch Reading Ease (0–100)
 *   - sentiment ∈ {positive, neutral, negative}
 *   - language detected via franc, defaults to "en"
 *   - empty/whitespace input → wordCount 0, keywords []
 *
 * CONTRACT: processJSON
 *
 * Input: JSON string
 * Output: { data?, keys? (max 20), raw? (max 500 chars), structure?, error? }
 *
 * Key invariants:
 *   - never throws: returns error field on invalid JSON
 *   - keys capped at 20, raw capped at 500 chars
 *   - structure describes Array/Object/Primitive
 */

describe("analyzeContent", () => {
	describe("boundary: empty and minimal input", () => {
		test("empty string → wordCount 0, readingTime 0, no keywords", () => {
			const result = analyzeContent("");
			expect(result.wordCount).toBe(0);
			expect(result.readingTime).toBe(0);
			expect(result.keywords).toEqual([]);
		});

		test("whitespace only → wordCount 0", () => {
			const result = analyzeContent("   \n\t   ");
			expect(result.wordCount).toBe(0);
			expect(result.keywords).toEqual([]);
		});

		test("single word → wordCount 1", () => {
			const result = analyzeContent("hello");
			expect(result.wordCount).toBe(1);
		});
	});

	describe("invariant: reading time formula", () => {
		test("readingTime = ceil(wordCount / 200)", () => {
			// 2 words → ceil(2/200) = 1
			expect(analyzeContent("hello world").readingTime).toBe(1);
			// 200 words → ceil(200/200) = 1
			expect(analyzeContent("word ".repeat(200).trim()).readingTime).toBe(1);
			// 201 words → ceil(201/200) = 2
			expect(analyzeContent("word ".repeat(201).trim()).readingTime).toBe(2);
			// 400 words → ceil(400/200) = 2
			expect(analyzeContent("word ".repeat(400).trim()).readingTime).toBe(2);
			// 401 words → ceil(401/200) = 3
			expect(analyzeContent("word ".repeat(401).trim()).readingTime).toBe(3);
		});
	});

	describe("reference: Flesch Reading Ease formula", () => {
		test("simple short sentences score higher than complex long ones", () => {
			// Simple: short words, short sentences
			const simple = analyzeContent(
				"The cat sat. The dog ran. The sun set. The bird sang.",
			);
			// Complex: long words, long sentences
			const complex = analyzeContent(
				"The telecommunications infrastructure fundamentally necessitates comprehensive organizational restructuring throughout the establishment.",
			);

			expect(simple.readabilityScore).toBeGreaterThan(complex.readabilityScore);
		});

		test("score is clamped to 0–100", () => {
			// Even extreme inputs stay in range
			const extreme = analyzeContent("a ".repeat(1000));
			expect(extreme.readabilityScore).toBeGreaterThanOrEqual(0);
			expect(extreme.readabilityScore).toBeLessThanOrEqual(100);
		});
	});

	describe("invariant: keywords", () => {
		test("max 10 items", () => {
			const text = Array.from({ length: 15 }, (_, i) =>
				`uniqueword${i} `.repeat(3),
			).join(" ");
			const result = analyzeContent(text);
			expect(result.keywords.length).toBeLessThanOrEqual(10);
		});

		test("sorted by count descending", () => {
			const result = analyzeContent("apple apple apple banana banana cherry");
			for (let i = 1; i < result.keywords.length; i++) {
				expect(result.keywords[i - 1].count).toBeGreaterThanOrEqual(
					result.keywords[i].count,
				);
			}
		});

		test("excludes stop words", () => {
			const result = analyzeContent("the quick brown fox");
			const words = result.keywords.map((k) => k.word);
			expect(words).not.toContain("the");
		});

		test("case-insensitive counting", () => {
			const result = analyzeContent("Apple APPLE apple");
			const apple = result.keywords.find((k) => k.word === "apple");
			expect(apple?.count).toBe(3);
		});

		test("strips non-alphanumeric characters", () => {
			const result = analyzeContent("hello-world test@email.com");
			const words = result.keywords.map((k) => k.word);
			expect(words.some((k) => k.includes("@"))).toBe(false);
		});

		test("counts frequency correctly", () => {
			const result = analyzeContent("apple apple apple banana");
			const apple = result.keywords.find((k) => k.word === "apple");
			expect(apple?.count).toBe(3);
		});
	});

	describe("sentiment classification", () => {
		test("detects positive sentiment", () => {
			const result = analyzeContent(
				"This is amazing! I love this wonderful product. Great experience!",
			);
			expect(result.sentiment).toBe("positive");
		});

		test("detects negative sentiment", () => {
			const result = analyzeContent(
				"This is terrible. I hate this awful product. Bad experience!",
			);
			expect(result.sentiment).toBe("negative");
		});

		test("detects neutral sentiment", () => {
			const result = analyzeContent(
				"The document contains information about the project.",
			);
			expect(result.sentiment).toBe("neutral");
		});
	});

	describe("language detection", () => {
		test("detects English", () => {
			const result = analyzeContent(
				"The quick brown fox jumps over the lazy dog.",
			);
			expect(result.language).toBe("en");
		});
	});
});

describe("processJSON", () => {
	describe("contract: parsing and structure detection", () => {
		test("object → keys, structure, data", () => {
			const result = processJSON('{"name":"test","value":123}');
			expect(result.data).toEqual({ name: "test", value: 123 });
			expect(result.error).toBeUndefined();
			expect(result.structure).toContain("Object with 2 keys");
		});

		test("array → structure description with count", () => {
			const result = processJSON('[{"name":"miku"},{"name":"rin"}]');
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.structure).toContain("Array with 2 items");
		});

		test("invalid JSON → error field, never throws", () => {
			const result = processJSON("{not-valid");
			expect(result.error).toBe("Invalid JSON");
		});

		test("preserves raw on error", () => {
			const payload = "invalid json";
			const result = processJSON(payload);
			expect(result.raw).toBe(payload);
		});
	});

	describe("invariant: keys capped at 20", () => {
		test("truncates keys beyond 20", () => {
			const obj: Record<string, number> = {};
			for (let i = 0; i < 30; i++) {
				obj[`key${i}`] = i;
			}
			const result = processJSON(JSON.stringify(obj));
			expect(result.keys?.length).toBe(20);
		});
	});

	describe("invariant: raw capped at 500 chars", () => {
		test("truncates raw beyond 500", () => {
			const largeObj: Record<string, string> = {};
			for (let i = 0; i < 100; i++) {
				largeObj[`key${i}`] = "x".repeat(100);
			}
			const result = processJSON(JSON.stringify(largeObj));
			expect(result.raw?.length).toBeLessThanOrEqual(500);
		});
	});
});
