// Shared between client and server

// Stats types
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
	pagesPerSecond?: string;
	successRate?: string;
}

export interface QueueStats {
	activeRequests: number;
	queueLength: number;
	elapsedTime: number;
	pagesPerSecond: number;
}

// Crawl options
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

// Page content
export interface CrawledPage {
	url: string;
	content: string;
	title?: string;
	description?: string;
	contentType?: string;
	domain?: string;
	processedData?: ProcessedPageData;
}

export interface ProcessedPageData {
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
}

// Socket events - Client to Server
export interface ClientToServerEvents {
	startAttack: (options: CrawlOptions) => void;
	stopAttack: () => void;
	getPageDetails: (url: string) => void;
	exportData: (format: "json" | "csv") => void;
}

// Socket events - Server to Client
export interface ServerToClientEvents {
	connect: () => void;
	disconnect: () => void;
	stats: (data: Stats & { log?: string }) => void;
	queueStats: (data: QueueStats) => void;
	pageContent: (data: CrawledPage) => void;
	exportResult: (data: { data: string; format: string }) => void;
	crawlError: (error: { message: string }) => void;
	error: (error: { message: string }) => void;
	attackEnd: (finalStats: Stats) => void;
	pageDetails: (data: CrawledPage | null) => void;
}

// Export format
export type ExportFormat = "json" | "csv";
