import type {
	ContentAnalysis,
	ExtractedData,
	MediaInfo,
	PageMetadata,
	ProcessingError,
} from "../shared/contracts/pageData.js";
import type { ExtractedLink } from "../shared/types.js";

/**
 * Server-side superset of processed data.
 * Includes 'links' which are extracted but not sent to frontend in the same structure.
 */
export interface ProcessedContent {
	url?: string;
	contentType?: string;
	extractedData: ExtractedData;
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
