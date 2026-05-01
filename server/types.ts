import type {
	ContentAnalysis,
	ExtractedData,
	ExtractedLink,
	MediaInfo,
	PageMetadata,
	ProcessingError,
} from "../shared/types.js";

/**
 * Server-side superset of processed data.
 * Includes 'links' which are extracted but not sent to frontend in the same structure.
 */
export interface ProcessedContent {
	url?: string;
	contentType?: string;
	extractedData: ExtractedData;
	// Server allows looser metadata typing (Record<string, string>) than frontend,
	// but we can make it compatible or just use the Shared definition + index signature
	metadata: PageMetadata;
	analysis: ContentAnalysis;
	media: MediaInfo[];
	links: ExtractedLink[];
	errors: ProcessingError[];
}

export interface LoggerLike {
	debug(message: string): void;
	warn(message: string): void;
	info(message: string): void;
	error(message: string): void;
}
