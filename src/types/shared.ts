/**
 * SHARED TYPES
 * These types are used by both the Frontend (React) and Backend (Bun/Elysia).
 * Ensure any changes here are compatible with both environments.
 */

export interface ExtractedLink {
	url: string;
	text?: string;
	title?: string;
	isInternal?: boolean;
	type?: string;
	domain?: string;
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
	mediaFiles?: number;
	successCount?: number;
	failureCount?: number;
	skippedCount?: number;
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

export interface CrawlOptions {
	target: string;
	crawlMethod: "links" | "content" | "media" | "full";
	crawlDepth: number;
	crawlDelay: number;
	maxPages: number;
	maxConcurrentRequests: number;
	retryLimit: number;
	dynamic: boolean;
	respectRobots: boolean;
	contentOnly: boolean;
	saveMedia: boolean;
}

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
