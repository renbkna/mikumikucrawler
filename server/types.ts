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
import type { ServerToClientEvents } from "../src/types/socket.js";
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

export interface FetchResult {
	content: string;
	statusCode: number;
	contentType: string;
	contentLength: number;
	title: string;
	description: string;
	lastModified: string | null;
	etag: string | null;
	isDynamic: boolean;
	/** Value of the X-Robots-Tag HTTP response header, if present. */
	xRobotsTag: string | null;
	/** True when server returned 304 Not Modified — caller should skip re-processing. */
	unchanged?: true;
	/** True when server returned 429/503 with a Retry-After directive. */
	rateLimited?: true;
	/** Milliseconds to wait before retrying, parsed from the Retry-After header. */
	retryAfterMs?: number;
	/** The actual URL after redirects (from response.url), if different from requested URL. */
	finalUrl?: string;
	/** True for 404, 410, 501 — do not retry these URLs. */
	permanentFailure?: true;
	/** True for 403 — bot detection, increase domain delay. */
	blocked?: true;
}

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
