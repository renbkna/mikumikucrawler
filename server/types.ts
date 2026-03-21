import type {
	ContentAnalysis,
	CrawlOptions,
	ExtractedData,
	ExtractedLink,
	MediaInfo,
	PageMetadata,
	ProcessingError,
} from "../src/types/shared.js";

// Re-export shared types
export * from "../src/types/shared.js";

export interface QueueItem {
	url: string;
	domain: string; // Pre-parsed at enqueue time to avoid repeated URL parsing
	depth: number;
	retries: number;
	parentUrl?: string;
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

export interface DynamicRenderConsentBlocked {
	type: "consentBlocked";
	message: string;
	statusCode: number;
}

export interface DynamicRenderSuccess {
	type: "success";
	result: DynamicRenderResult;
}

export type DynamicRenderAttempt =
	| DynamicRenderSuccess
	| DynamicRenderConsentBlocked
	| null;

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
	reason?: string;
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

export interface LoggerLike {
	debug(message: string): void;
	warn(message: string): void;
	info(message: string): void;
	error(message: string): void;
}
