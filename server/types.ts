import type { ContentAnalysis, ExtractedData, PageMetadata } from "../shared/contracts/pageData.js";

export interface ExtractedLink {
	url: string;
	/** True when the anchor element carries rel="nofollow" or rel="ugc". */
	nofollow?: boolean;
}

export interface ProcessingError {
	type: string;
	message: string;
	timestamp?: string;
}

export interface ProcessedContent {
	extractedData: ExtractedData;
	metadata: PageMetadata;
	analysis: ContentAnalysis;
	mediaCount: number;
	links: ExtractedLink[];
	errors: ProcessingError[];
}

export interface LoggerLike {
	debug(message: string): void;
	warn(message: string): void;
	info(message: string): void;
	error(message: string): void;
}
