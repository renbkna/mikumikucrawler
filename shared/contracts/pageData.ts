export const MediaTypeValues = ["image", "video", "audio"] as const;

export interface MediaInfo {
	type: (typeof MediaTypeValues)[number];
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

export type PageMetadata = Record<string, string>;

export interface ProcessedPageData {
	extractedData: ExtractedData;
	metadata: PageMetadata;
	analysis: ContentAnalysis;
	media: MediaInfo[];
	errors?: ProcessingError[];
	qualityScore: number;
	language: string;
}

export interface QueueStats {
	activeRequests: number;
	queueLength: number;
	elapsedTime: number;
	pagesPerSecond: number;
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
