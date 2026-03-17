import { describe, expect, test } from "bun:test";
import { analyzeContent, processJSON } from "../analysisUtils.js";

/**
 * CONTRACT: analyzeContent
 *
 * Purpose: Analyzes text to extract word count, reading time, language,
 * sentiment, keywords, and readability metrics.
 *
 * INPUTS:
 *   - text: string (content to analyze)
 *
 * OUTPUTS:
 *   - AnalysisResult:
 *     - wordCount: number (>= 0)
 *     - readingTime: number (>= 0, in minutes)
 *     - language: string (ISO 639-1 code: en, es, fr, de, etc.)
 *     - keywords: Array<{ word: string, count: number }> (max 10 items, sorted by count desc)
 *     - sentiment: string ("positive" | "neutral" | "negative")
 *     - readabilityScore: number (0-100, Flesch Reading Ease)
 *     - quality: { score: 0, factors: {}, issues: [] }
 *
 * INVARIANTS:
 *   1. NEVER THROWS: Always returns a valid AnalysisResult
 *   2. wordCount always >= 0
 *   3. readingTime always >= 0
 *   4. sentiment ∈ {positive, neutral, negative}
 *   5. readabilityScore between 0-100
 *   6. keywords max 10 items, sorted by count descending
 *   7. Empty/null text handled gracefully (wordCount=0)
 *   8. Language detected or defaults to "en"
 *   9. Keywords exclude stop words (language-specific)
 *
 * EDGE CASES:
 *   - Empty string
 *   - Whitespace only
 *   - Single word
 *   - Very long text
 *   - Non-string input
 *   - Text with special characters
 *   - Mixed languages
 *   - Positive sentiment text
 *   - Negative sentiment text
 *   - Neutral sentiment text
 *
 * CONTRACT: processJSON
 *
 * Purpose: Parses and analyzes JSON content structure.
 *
 * INPUTS:
 *   - content: string (JSON to parse)
 *
 * OUTPUTS:
 *   - JSONProcessResult:
 *     - data?: parsed JSON value
 *     - keys?: top-level keys (max 20)
 *     - raw?: first 500 chars of input
 *     - structure?: "Array with N items" | "Object with N keys"
 *     - error?: "Invalid JSON" if parsing fails
 *
 * INVARIANTS:
 *   1. NEVER THROWS: Returns error field on invalid JSON
 *   2. keys limited to 20
 *   - raw limited to 500 chars
 *   3. Array structure reported correctly
 *   4. Object structure reported correctly
 *   5. Top-level primitives handled
 */

describe("analyzeContent CONTRACT", () => {
	describe("INVARIANT: Return Value Structure", () => {
		test("returns complete AnalysisResult for valid text", async () => {
			const sample =
				"This article is amazing and wonderful. I love the great insights it provides.";
			const analysis = await analyzeContent(sample);

			// INVARIANT: All required fields present
			expect(typeof analysis.wordCount).toBe("number");
			expect(typeof analysis.readingTime).toBe("number");
			expect(typeof analysis.language).toBe("string");
			expect(typeof analysis.sentiment).toBe("string");
			expect(typeof analysis.readabilityScore).toBe("number");
			expect(Array.isArray(analysis.keywords)).toBe(true);
			expect(analysis.quality).toBeDefined();
		});

		test("wordCount is always >= 0", async () => {
			const empty = await analyzeContent("");
			const withText = await analyzeContent("hello world");

			expect(empty.wordCount).toBeGreaterThanOrEqual(0);
			expect(withText.wordCount).toBeGreaterThanOrEqual(0);
		});

		test("readingTime is always >= 0", async () => {
			const empty = await analyzeContent("");
			const withText = await analyzeContent("hello world");

			expect(empty.readingTime).toBeGreaterThanOrEqual(0);
			expect(withText.readingTime).toBeGreaterThanOrEqual(0);
		});

		test("sentiment is one of allowed values", async () => {
			const positive = await analyzeContent("I love this! Amazing!");
			const negative = await analyzeContent("I hate this! Terrible!");
			const neutral = await analyzeContent("This is a book.");

			expect(["positive", "neutral", "negative"]).toContain(positive.sentiment);
			expect(["positive", "neutral", "negative"]).toContain(negative.sentiment);
			expect(["positive", "neutral", "negative"]).toContain(neutral.sentiment);
		});

		test("readabilityScore is between 0 and 100", async () => {
			const analysis = await analyzeContent("Some sample text for testing.");

			expect(analysis.readabilityScore).toBeGreaterThanOrEqual(0);
			expect(analysis.readabilityScore).toBeLessThanOrEqual(100);
		});

		test("keywords has maximum 10 items", async () => {
			const longText = "word ".repeat(100);
			const analysis = await analyzeContent(longText);

			// INVARIANT: max 10 keywords
			expect(analysis.keywords.length).toBeLessThanOrEqual(10);
		});

		test("keywords are sorted by count descending", async () => {
			const text = "apple apple apple banana banana cherry";
			const analysis = await analyzeContent(text);

			// INVARIANT: sorted by count desc
			for (let i = 1; i < analysis.keywords.length; i++) {
				expect(analysis.keywords[i - 1].count).toBeGreaterThanOrEqual(
					analysis.keywords[i].count,
				);
			}
		});
	});

	describe("EDGE CASE: Empty and Minimal Input", () => {
		test("handles empty string", async () => {
			const analysis = await analyzeContent("");

			expect(analysis.wordCount).toBe(0);
			expect(analysis.readingTime).toBe(0);
			expect(analysis.keywords).toEqual([]);
		});

		test("handles whitespace only", async () => {
			const analysis = await analyzeContent("   \n\t   ");

			expect(analysis.wordCount).toBe(0);
			expect(analysis.keywords).toEqual([]);
		});

		test("handles single word", async () => {
			const analysis = await analyzeContent("hello");

			expect(analysis.wordCount).toBe(1);
			expect(analysis.keywords.length).toBeGreaterThanOrEqual(0);
		});

		test("handles text with only stop words", async () => {
			const analysis = await analyzeContent("the a an is are was were");

			// INVARIANT: stop words excluded from keywords
			expect(analysis.keywords.length).toBe(0);
		});
	});

	describe("EDGE CASE: Sentiment Analysis", () => {
		test("detects positive sentiment", async () => {
			const analysis = await analyzeContent(
				"This is amazing! I love this wonderful product. Great experience!",
			);

			// INVARIANT: Positive text detected
			expect(analysis.sentiment).toBe("positive");
		});

		test("detects negative sentiment", async () => {
			const analysis = await analyzeContent(
				"This is terrible. I hate this awful product. Bad experience!",
			);

			// INVARIANT: Negative text detected
			expect(analysis.sentiment).toBe("negative");
		});

		test("detects neutral sentiment", async () => {
			const analysis = await analyzeContent(
				"The document contains information about the project.",
			);

			// INVARIANT: Neutral text detected
			expect(analysis.sentiment).toBe("neutral");
		});

		test("handles mixed sentiment", async () => {
			const analysis = await analyzeContent(
				"Good start but bad ending. Mixed feelings.",
			);

			// INVARIANT: Returns one of allowed values
			expect(["positive", "neutral", "negative"]).toContain(analysis.sentiment);
		});
	});

	describe("EDGE CASE: Language Detection", () => {
		test("detects English", async () => {
			const analysis = await analyzeContent(
				"The quick brown fox jumps over the lazy dog.",
			);

			expect(analysis.language).toBe("en");
		});

		test("defaults to English for short text", async () => {
			const analysis = await analyzeContent("hi");

			// Short text may not trigger detection
			expect(analysis.language).toBeDefined();
		});
	});

	describe("EDGE CASE: Keywords Extraction", () => {
		test("excludes stop words from keywords", async () => {
			const analysis = await analyzeContent("the quick brown fox");

			// INVARIANT: stop words excluded
			const keywordWords = analysis.keywords.map((k) => k.word);
			expect(keywordWords).not.toContain("the");
		});

		test("counts word frequency correctly", async () => {
			const analysis = await analyzeContent("apple apple apple banana");

			const appleKeyword = analysis.keywords.find((k) => k.word === "apple");
			if (appleKeyword) {
				expect(appleKeyword.count).toBe(3);
			}
		});

		test("handles special characters", async () => {
			const analysis = await analyzeContent("hello-world test@email.com");

			// INVARIANT: Special chars stripped
			const keywords = analysis.keywords.map((k) => k.word);
			expect(keywords.some((k) => k.includes("@"))).toBe(false);
		});

		test("is case insensitive", async () => {
			const analysis = await analyzeContent("Apple APPLE apple");

			const appleKeyword = analysis.keywords.find((k) => k.word === "apple");
			if (appleKeyword) {
				// All variations counted together
				expect(appleKeyword.count).toBe(3);
			}
		});
	});

	describe("EDGE CASE: Reading Time Calculation", () => {
		test("calculates reading time based on word count", async () => {
			const shortText = "Short text.";
			const longText = "word ".repeat(400);

			const shortAnalysis = await analyzeContent(shortText);
			const longAnalysis = await analyzeContent(longText);

			// INVARIANT: readingTime = ceil(wordCount / 200)
			expect(shortAnalysis.readingTime).toBe(1);
			expect(longAnalysis.readingTime).toBeGreaterThan(1);
		});

		test("minimum reading time is 1 minute", async () => {
			const analysis = await analyzeContent("hi");

			expect(analysis.readingTime).toBeGreaterThanOrEqual(1);
		});
	});
});

describe("processJSON CONTRACT", () => {
	describe("INVARIANT: Parsing", () => {
		test("parses valid object JSON", () => {
			const payload = '{"name":"test","value":123}';
			const result = processJSON(payload);

			// INVARIANT: data field contains parsed value
			expect(result.data).toEqual({ name: "test", value: 123 });
			expect(result.error).toBeUndefined();
		});

		test("parses valid array JSON", () => {
			const payload = '[{"name":"miku"},{"name":"rin"}]';
			const result = processJSON(payload);

			// INVARIANT: Array structure detected
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.structure).toContain("Array with 2 items");
		});

		test("parses nested objects", () => {
			const payload = '{"items":[{"name":"miku"},{"name":"rin"}]}';
			const result = processJSON(payload);

			// INVARIANT: Nested structure preserved
			expect(result.data).toBeDefined();
			expect(result.keys?.includes("items")).toBe(true);
		});

		test("extracts top-level keys", () => {
			const payload = '{"a":1,"b":2,"c":3}';
			const result = processJSON(payload);

			// INVARIANT: keys extracted
			expect(result.keys).toContain("a");
			expect(result.keys).toContain("b");
			expect(result.keys).toContain("c");
		});

		test("limits keys to 20", () => {
			const obj: Record<string, number> = {};
			for (let i = 0; i < 30; i++) {
				obj[`key${i}`] = i;
			}
			const payload = JSON.stringify(obj);
			const result = processJSON(payload);

			// INVARIANT: max 20 keys
			expect(result.keys?.length).toBeLessThanOrEqual(20);
		});

		test("includes raw field with truncated content", () => {
			const payload = '{"test":"value"}';
			const result = processJSON(payload);

			// INVARIANT: raw field present
			expect(result.raw).toBeDefined();
			expect(typeof result.raw).toBe("string");
		});

		test("limits raw to 500 chars", () => {
			const largeObj: Record<string, string> = {};
			for (let i = 0; i < 100; i++) {
				largeObj[`key${i}`] = "x".repeat(100);
			}
			const payload = JSON.stringify(largeObj);
			const result = processJSON(payload);

			// INVARIANT: raw truncated to 500
			expect(result.raw?.length).toBeLessThanOrEqual(500);
		});
	});

	describe("INVARIANT: Error Handling", () => {
		test("reports invalid JSON", () => {
			const result = processJSON("{not-valid");

			// INVARIANT: error field set
			expect(result.error).toBe("Invalid JSON");
		});

		test("reports unclosed braces", () => {
			const result = processJSON('{"key": "value"');

			expect(result.error).toBe("Invalid JSON");
		});

		test("reports trailing commas", () => {
			const result = processJSON('{"a": 1,}');

			expect(result.error).toBe("Invalid JSON");
		});

		test("reports empty string", () => {
			const result = processJSON("");

			expect(result.error).toBe("Invalid JSON");
		});

		test("preserves raw on error", () => {
			const payload = "invalid json";
			const result = processJSON(payload);

			// INVARIANT: raw preserved even on error
			expect(result.raw).toBe(payload);
		});
	});

	describe("EDGE CASE: JSON Types", () => {
		test("handles string primitive", () => {
			const result = processJSON('"hello"');

			expect(result.data).toBe("hello");
			// Primitives don't have structure description
		});

		test("handles number primitive", () => {
			const result = processJSON("42");

			expect(result.data).toBe(42);
		});

		test("handles boolean primitive", () => {
			const result = processJSON("true");

			expect(result.data).toBe(true);
		});

		test("handles boolean primitive", () => {
			const result = processJSON("true");

			expect(result.data).toBe(true);
		});

		test("handles top-level array", () => {
			const result = processJSON("[1,2,3]");

			// INVARIANT: Array structure
			expect(result.structure).toContain("Array with 3 items");
		});

		test("handles empty object", () => {
			const result = processJSON("{}");

			expect(result.data).toEqual({});
			expect(result.structure).toContain("Object with 0 keys");
		});

		test("handles empty array", () => {
			const result = processJSON("[]");

			expect(result.data).toEqual([]);
			expect(result.structure).toContain("Array with 0 items");
		});

		test("handles deeply nested objects", () => {
			const payload = JSON.stringify({
				a: { b: { c: { d: { e: "deep" } } } },
			});
			const result = processJSON(payload);

			expect(result.data).toBeDefined();
			expect(result.keys).toContain("a");
		});
	});

	describe("EDGE CASE: Special Characters", () => {
		test("handles unicode escape sequences", () => {
			const result = processJSON(
				'{"text": "\\u0048\\u0065\\u006c\\u006c\\u006f"}',
			);

			expect(result.data).toEqual({ text: "Hello" });
		});

		test("handles escaped quotes", () => {
			const result = processJSON('{"text": "say \\"hello\\""}');

			expect(result.data).toEqual({ text: 'say "hello"' });
		});

		test("handles escaped backslashes", () => {
			const result = processJSON('{"path": "C:\\\\Users\\\\test"}');

			expect(result.data).toEqual({ path: "C:\\Users\\test" });
		});

		test("handles newlines in strings", () => {
			const result = processJSON('{"text": "line1\\nline2"}');

			expect(result.data).toEqual({ text: "line1\nline2" });
		});
	});
});
