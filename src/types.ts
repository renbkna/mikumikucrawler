// Extended interfaces for better type safety
export interface Stats {
	pagesScanned: number;
	linksFound: number;
	totalData: number; // in KB
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
}

export interface QueueStats {
	activeRequests: number;
	queueLength: number;
	elapsedTime: number;
	pagesPerSecond: number;
}

export interface StatsPayload extends Partial<Stats> {
	log?: string;
}

export interface CrawledPage {
	id: number;
	url: string;
	content?: string;
	title?: string;
	description?: string;
	contentType?: string;
	domain?: string;
	processedData?: {
		extractedData: {
			mainContent?: string;
			jsonLd?: Record<string, unknown>[];
			microdata?: Record<string, unknown>;
			openGraph?: Record<string, string>;
			twitterCards?: Record<string, string>;
			schema?: Record<string, unknown>;
		};
		metadata: {
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
		};
		analysis: {
			wordCount: number;
			readingTime: number;
			language: string;
			keywords: Array<{ word: string; count: number }>;
			sentiment: string;
			readabilityScore: number;
			quality?: {
				score: number;
				factors: Record<string, number | boolean>;
				issues: string[];
			};
		};
		media: Array<{
			type: string;
			url: string;
			alt?: string;
			title?: string;
			width?: string;
			height?: string;
			poster?: string;
		}>;
		qualityScore: number;
		language: string;
	};
}

// Crawl configuration options
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

// Toast notification system
export interface Toast {
	id: number;
	type: "success" | "error" | "info" | "warning";
	message: string;
	timeout: number;
}
