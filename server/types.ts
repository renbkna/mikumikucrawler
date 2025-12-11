// Shared types for the server
// Re-export frontend types that are also used on the backend
export type {
	CrawledPage,
	CrawlOptions,
	QueueStats,
	Stats,
} from "../src/types.js";

import type Database from "better-sqlite3";
import type { Socket, Server as SocketIOServer } from "socket.io";
import type { Logger } from "winston";
import type { CrawlOptions, Stats } from "../src/types.js";

// Queue item for crawling
export interface QueueItem {
	url: string;
	depth: number;
	retries: number;
	parentUrl?: string;
}

// Raw options from client before validation
export interface RawCrawlOptions {
	target?: string;
	crawlDepth?: number;
	maxPages?: number;
	crawlDelay?: number;
	crawlMethod?: string;
	maxConcurrentRequests?: number;
	retryLimit?: number;
	dynamic?: boolean;
	respectRobots?: boolean;
	contentOnly?: boolean;
	saveMedia?: boolean;
}

// Validated and sanitized options
export interface SanitizedCrawlOptions extends CrawlOptions {
	filterDuplicates?: boolean;
	screenshots?: boolean;
}

// Dynamic render result
export interface DynamicRenderResult {
	isDynamic: boolean;
	content: string;
	statusCode: number;
	contentType: string;
	contentLength: number;
	title: string;
	description: string;
	lastModified?: string;
}

// Fetch result from pagePipeline
export interface FetchResult {
	content: string;
	statusCode: number;
	contentType: string;
	contentLength: number;
	title: string;
	description: string;
	lastModified: string | null;
	isDynamic: boolean;
}

// Processed content from ContentProcessor
export interface ProcessedContent {
	url?: string;
	contentType?: string;
	extractedData: {
		mainContent?: string;
		jsonLd?: unknown[];
		microdata?: Record<string, unknown>;
		openGraph?: Record<string, string>;
		twitterCards?: Record<string, string>;
		schema?: Record<string, unknown>;
	};
	metadata: Record<string, string>;
	analysis: {
		wordCount?: number;
		readingTime?: number;
		language?: string;
		keywords?: Array<{ word: string; count: number }>;
		sentiment?: string;
		readabilityScore?: number;
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
	}>;
	links: Array<{
		url: string;
		text?: string;
		title?: string;
		isInternal?: boolean;
		type?: string;
		domain?: string;
	}>;
	errors: Array<{
		type: string;
		message: string;
		timestamp?: string;
	}>;
}

// Crawl state stats
export interface CrawlStats extends Stats {
	isActive?: boolean;
	startTime?: number;
}

// Link extracted from page
export interface ExtractedLink {
	url: string;
	text?: string;
	title?: string;
	isInternal?: boolean;
	type?: string;
	domain?: string;
}

// Media info
export interface MediaInfo {
	type: "image" | "video" | "audio";
	url: string;
	alt?: string;
	title?: string;
	width?: string;
	height?: string;
	poster?: string;
}

// Type aliases for external libraries
export type DatabaseInstance = Database.Database;
export type SocketInstance = Socket;
export type SocketServer = SocketIOServer;
export type LoggerInstance = Logger;

// Clamp number options
export interface ClampOptions {
	min: number;
	max: number;
	fallback: number;
}
