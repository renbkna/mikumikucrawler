export type {
	CrawledPage,
	CrawlOptions,
	ProcessedPageData,
	QueueStats,
	Stats,
} from "../src/types.js";

import type { Database } from "bun:sqlite";
import type { ServerToClientEvents } from "../src/types/socket.js";
import type { CrawlOptions, Stats } from "../src/types.js";
import type { Logger } from "./config/logging.js";

export interface QueueItem {
	url: string;
	depth: number;
	retries: number;
	parentUrl?: string;
}

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

export interface SanitizedCrawlOptions extends CrawlOptions {
	filterDuplicates?: boolean;
	screenshots?: boolean;
}

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

export interface CrawlStats extends Stats {
	isActive?: boolean;
	startTime?: number;
}

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

export type DatabaseInstance = Database;
export interface CrawlerSocket {
	id: string;
	emit<K extends keyof ServerToClientEvents>(
		event: K,
		...args: Parameters<ServerToClientEvents[K]>
	): void;
}
export type SocketInstance = CrawlerSocket;
export type LoggerInstance = Logger;

export interface ClampOptions {
	min: number;
	max: number;
	fallback: number;
}

export interface DatabaseStatement {
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	run(...params: unknown[]): void;
}

export interface DatabaseLike {
	query(sql: string): DatabaseStatement;
}

export interface LoggerLike {
	warn(message: string): void;
	info(message: string): void;
	error(message: string): void;
}
