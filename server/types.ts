import type { Database } from "bun:sqlite";
import type {
	ContentAnalysis,
	CrawlOptions,
	ExtractedData,
	ExtractedLink,
	MediaInfo,
	PageMetadata,
	ProcessingError,
	Stats,
} from "../src/types/shared.js";
import type { Logger } from "./config/logging.js";

// Re-export shared types
export * from "../src/types/shared.js";

export interface QueueItem {
	url: string;
	domain: string; // Pre-parsed at enqueue time to avoid repeated URL parsing
	depth: number;
	retries: number;
	parentUrl?: string;
}

export interface RawCrawlOptions {
	target?: string;
	crawlDepth?: number;
	maxPages?: number;
	/** Per-domain page cap. 0 = unlimited. */
	maxPagesPerDomain?: number;
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
	/** Value of the X-Robots-Tag HTTP response header, if present. */
	xRobotsTag?: string | null;
}

/** Base fields shared by all fetch result variants. */
interface FetchResultBase {
	statusCode: number;
	finalUrl?: string;
}

/** Successful fetch with content. */
export interface FetchSuccess extends FetchResultBase {
	type: "success";
	content: string;
	contentType: string;
	contentLength: number;
	title: string;
	description: string;
	lastModified: string | null;
	etag: string | null;
	isDynamic: boolean;
	xRobotsTag: string | null;
}

/** 304 Not Modified — content unchanged since last crawl. */
export interface FetchUnchanged extends FetchResultBase {
	type: "unchanged";
	lastModified: string | null;
	etag: string | null;
}

/** 429/503 — server is rate limiting. */
export interface FetchRateLimited extends FetchResultBase {
	type: "rateLimited";
	retryAfterMs: number;
}

/** 404/410/501 — permanent failure, do not retry. */
export interface FetchPermanentFailure extends FetchResultBase {
	type: "permanentFailure";
}

/** 403 — blocked by bot detection. */
export interface FetchBlocked extends FetchResultBase {
	type: "blocked";
}

export type FetchResult =
	| FetchSuccess
	| FetchUnchanged
	| FetchRateLimited
	| FetchPermanentFailure
	| FetchBlocked;

/**
 * Server-side superset of processed data.
 * Includes 'links' which are extracted but not sent to frontend in the same structure.
 */
export interface ProcessedContent {
	url?: string;
	contentType?: string;
	extractedData: ExtractedData;
	// Server allows looser metadata typing (Record<string, string>) than frontend,
	// but we can make it compatible or just use the Shared definition + index signature
	metadata: PageMetadata;
	analysis: ContentAnalysis;
	media: MediaInfo[];
	links: ExtractedLink[];
	errors: ProcessingError[];
}

export interface CrawlStats extends Stats {
	isActive?: boolean;
	startTime?: number;
}

export type DatabaseInstance = Database;
export interface CrawlerSocket {
	id: string;
	emit(event: string, data?: unknown): void;
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
	debug(message: string): void;
	warn(message: string): void;
	info(message: string): void;
	error(message: string): void;
}

/** A single URL entry discovered from a sitemap.xml file. */
export interface SitemapEntry {
	url: string;
	lastmod?: string;
	priority?: number;
	changefreq?: string;
}
