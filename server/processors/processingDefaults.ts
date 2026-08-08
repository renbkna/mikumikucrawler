import type { ProcessedContent } from "../types.js";

export function applyProcessingErrorDefaults(result: ProcessedContent): void {
	result.extractedData = { mainContent: "" };
	result.analysis = {
		wordCount: 0,
		readingTime: 0,
		language: "unknown",
	};
	result.metadata = {};
	result.mediaCount = 0;
	result.links = [];
}
