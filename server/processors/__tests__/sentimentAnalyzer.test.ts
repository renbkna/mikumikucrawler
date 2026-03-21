import { describe, expect, test } from "bun:test";
import { analyzeSentiment } from "../sentimentAnalyzer.js";

/**
 * CONTRACT: analyzeSentiment
 *
 * Input: text string
 * Output: { label: "positive" | "negative" | "neutral", confidence: number }
 *
 * Key invariants:
 *   - short text (<10 chars) → neutral with 0.5 confidence
 *   - no sentiment words → neutral
 *   - negation flips sentiment within 3-word window
 *   - negation expires after 3 words
 *   - confidence ∈ [0.5, 1.0], scales with ratio of dominant sentiment
 */

describe("analyzeSentiment", () => {
	describe("boundary: short and empty input", () => {
		test("text shorter than 10 chars → neutral with 0.5 confidence", () => {
			const result = analyzeSentiment("great!");
			expect(result.label).toBe("neutral");
			expect(result.confidence).toBe(0.5);
		});

		test("empty string → neutral", () => {
			const result = analyzeSentiment("");
			expect(result.label).toBe("neutral");
			expect(result.confidence).toBe(0.5);
		});
	});

	describe("basic classification", () => {
		test("positive words → positive label", () => {
			const result = analyzeSentiment("This product is amazing and wonderful");
			expect(result.label).toBe("positive");
		});

		test("negative words → negative label", () => {
			const result = analyzeSentiment("This product is terrible and awful");
			expect(result.label).toBe("negative");
		});

		test("no sentiment words → neutral", () => {
			const result = analyzeSentiment(
				"The document contains information about procedures",
			);
			expect(result.label).toBe("neutral");
		});
	});

	describe("invariant: negation window", () => {
		test("negation flips positive to negative within 3 words", () => {
			const result = analyzeSentiment(
				"I think this product is not great or amazing for anyone",
			);
			expect(result.label).toBe("negative");
		});

		test("negation flips negative to positive within 3 words", () => {
			const result = analyzeSentiment(
				"This is not terrible or bad in any way, it is really great",
			);
			expect(result.label).toBe("positive");
		});

		test("negation expires after 3 words — distant sentiment unaffected", () => {
			// "not" at position 2, "amazing" at position 8 (6 words apart) — should NOT be flipped
			const result = analyzeSentiment(
				"It is not clear what the outcome is but amazing results were found to be great",
			);
			expect(result.label).toBe("positive");
		});
	});

	describe("confidence scaling", () => {
		test("pure positive text → confidence above 0.5", () => {
			const result = analyzeSentiment(
				"Amazing wonderful excellent fantastic brilliant",
			);
			expect(result.confidence).toBeGreaterThan(0.5);
		});

		test("mixed sentiment → lower confidence than pure", () => {
			const pure = analyzeSentiment(
				"Amazing wonderful excellent fantastic brilliant",
			);
			const mixed = analyzeSentiment(
				"Amazing wonderful but terrible and awful too",
			);
			expect(mixed.confidence).toBeLessThan(pure.confidence);
		});
	});
});
