import type { ProcessedContent } from "../types.js";

export function applyProcessingErrorDefaults(
	result: ProcessedContent,
	issue = "Processing failed",
): void {
	result.extractedData = { mainContent: "" };
	result.analysis = {
		wordCount: 0,
		readingTime: 0,
		language: "unknown",
		keywords: [],
		sentiment: "neutral",
		readabilityScore: 0,
		quality: { score: 0, factors: {}, issues: [issue] },
	};
	result.metadata = {};
	result.media = [];
	result.links = [];
}
