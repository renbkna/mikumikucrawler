export interface ExtractedLink {
	url: string;
	text?: string;
	title?: string;
	isInternal?: boolean;
	type?: string;
	domain?: string;
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
		title?: string;
		wordCount?: number;
		qualityScore?: number;
		language?: string;
		mediaCount?: number;
		linksCount?: number;
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
	id?: number | null;
	url: string;
	content?: string;
	title?: string;
	description?: string;
	contentType?: string;
	domain?: string;
	processedData?: ProcessedPageData;
	links?: ExtractedLink[];
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

/**
 * Socket events sent from the Client to the Server.
 */
export interface ClientToServerEvents {
	startAttack: (options: CrawlOptions) => void;
	stopAttack: () => void;
	getPageDetails: (url: string) => void;
	exportData: (format: string) => void;
}

/**
 * Socket events sent from the Server to the Client.
 */
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
	exportStart: (data: { format: string }) => void;
	exportChunk: (data: { data: string }) => void;
	exportComplete: (data: { count: number }) => void;
}

export type ExportFormat = "json" | "csv";
