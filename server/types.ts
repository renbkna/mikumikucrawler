import type { PageMetadata } from "../shared/contracts/pageData.js";

export interface ExtractedLink {
	url: string;
	/** True when the anchor element carries rel="nofollow" or rel="ugc". */
	nofollow?: boolean;
}

export interface ContentAnalysis {
	wordCount: number;
	readingTime: number;
	/** ISO 639-1 code, or "unknown" when detection is inconclusive. */
	language: string;
}

export interface ProcessedContent {
	mainContent: string;
	metadata: PageMetadata;
	analysis: ContentAnalysis;
	mediaCount: number;
	links: ExtractedLink[];
}

export type ContentProcessingResult =
	| { type: "processed"; content: ProcessedContent }
	| { type: "failed"; message: string };
