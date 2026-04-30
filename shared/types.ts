import type { CrawlOptions } from "./contracts/crawl.js";

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

export interface MediaInfo {
	type: "image" | "video" | "audio";
	url: string;
	alt?: string;
	title?: string;
	width?: string;
	height?: string;
	poster?: string;
}

export interface ProcessingError {
	type: string;
	message: string;
	timestamp?: string;
}

export interface QualityAnalysis {
	score: number;
	factors: Record<string, number | boolean>;
	issues: string[];
}

export interface ContentAnalysis {
	wordCount?: number;
	readingTime?: number;
	language?: string;
	keywords?: Array<{ word: string; count: number }>;
	sentiment?: string;
	readabilityScore?: number;
	quality?: QualityAnalysis;
}

export interface ExtractedData {
	mainContent?: string;
	jsonLd?: Record<string, unknown>[];
	microdata?: Record<string, unknown>;
	openGraph?: Record<string, string>;
	twitterCards?: Record<string, string>;
	schema?: Record<string, unknown>;
}

export interface PageMetadata {
	title?: string;
	description?: string;
	author?: string;
	publishDate?: string;
	modifiedDate?: string;
	canonical?: string;
	robots?: string;
	viewport?: string;
	charset?: string;
	generator?: string;
	[key: string]: string | undefined;
}

export interface ProcessedPageData {
	extractedData: ExtractedData;
	metadata: PageMetadata;
	analysis: ContentAnalysis;
	media: MediaInfo[];
	errors?: ProcessingError[];
	qualityScore: number;
	language: string;
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

export interface QueueStats {
	activeRequests: number;
	queueLength: number;
	elapsedTime: number;
	pagesPerSecond: number;
}

export type { CrawlOptions };

export interface CrawledPage {
	id: number | null;
	url: string;
	content?: string;
	title?: string;
	description?: string;
	contentType?: string;
	domain?: string;
	processedData?: ProcessedPageData;
}
