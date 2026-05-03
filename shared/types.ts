import type { CrawlOptions } from "./contracts/crawl.js";
export type {
	ContentAnalysis,
	CrawledPage,
	ExtractedData,
	MediaInfo,
	PageMetadata,
	ProcessedPageData,
	ProcessingError,
	QualityAnalysis,
	QueueStats,
} from "./contracts/pageData.js";
export {
	isCrawledPage,
	isProcessedPageData,
	isQueueStats,
} from "./contracts/validation.js";

/**
 * Shared runtime-facing types used by both the React client and Bun server.
 * These live outside `src/` so neither runtime depends on the other's module
 * tree for cross-boundary contracts.
 */
export interface ExtractedLink {
	url: string;
	text?: string;
	title?: string;
	isInternal?: boolean;
	type?: string;
	domain?: string;
	/** True when the anchor element carries rel="nofollow" or rel="ugc". */
	nofollow?: boolean;
}

export interface Stats {
	pagesScanned: number;
	linksFound: number;
	totalData: number;
	mediaFiles: number;
	successCount: number;
	failureCount: number;
	skippedCount: number;
	elapsedTime?: {
		hours: number;
		minutes: number;
		seconds: number;
	};
	pagesPerSecond?: number | string;
	successRate?: string;
	lastProcessed?: {
		url: string;
		wordCount: number;
		qualityScore: number;
		language: string;
		mediaCount: number;
		linksCount: number;
	};
}

export type { CrawlOptions };
