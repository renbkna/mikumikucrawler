import { config } from "./config/env.js";

export const CRAWL_QUEUE_CONSTANTS = {
	DEFAULT_SLEEP_MS: 100,
	ITEM_PROCESSING_TIMEOUT_MS: 180000,
	MAX_ACTIVE_RUNTIMES: 8,
} as const;

export const TIMEOUT_CONSTANTS = {
	DOCUMENT_FETCH: 10000, // 10s for static and browser document acquisition
	CONTENT_PROCESSING: 5000, // 5s for HTML parsing/analysis
} as const;

export const RETRY_CONSTANTS = {
	BASE_DELAY: 1000,
	MAX_DELAY: 30000,
} as const;

/** Every scheduler delay must remain finite and at or below this liveness ceiling. */
export const DOMAIN_DELAY_CONSTANTS = {
	MAX_MS: 60_000,
} as const;

/** Standard HTTP headers for crawling requests */
export const FETCH_HEADERS = {
	"User-Agent": config.userAgent,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"Accept-Encoding": "gzip, deflate",
} as const;

/** Memory and cache configuration */
export const MEMORY_CONSTANTS = {
	/** Maximum entries in robots.txt cache */
	ROBOTS_CACHE_MAX_SIZE: 100,
	/** TTL for robots.txt cache entries in ms (30 minutes) */
	ROBOTS_CACHE_TTL_MS: 30 * 60 * 1000,
} as const;

/** Request and fetch configuration */
export const REQUEST_CONSTANTS = {
	/** Timeout for robots.txt fetch in ms (5 seconds) */
	ROBOTS_FETCH_TIMEOUT_MS: 5000,
	/** Maximum robots.txt body size to buffer (512 KiB). */
	MAX_ROBOTS_RESPONSE_BYTES: 512 * 1024,
	/** Maximum decoded HTML/JSON document size admitted to synchronous processing (1 MiB). */
	MAX_TEXT_DOCUMENT_BYTES: 1 * 1024 * 1024,
} as const;

/** PDF processing limits to prevent resource exhaustion */
export const PDF_CONSTANTS = {
	/** Maximum number of pages to process per PDF (prevents memory exhaustion) */
	MAX_PAGES: 1000,
	/** Maximum file size in MB */
	MAX_FILE_SIZE_MB: 50,
	/** Maximum UTF-8 bytes retained from decompressed PDF text. */
	MAX_EXTRACTED_TEXT_BYTES: 1 * 1024 * 1024,
	/** Maximum text objects traversed even when they contain little or no text. */
	MAX_TEXT_ITEMS: 200_000,
	/** Timeout for PDF processing in ms (30 seconds) */
	PROCESSING_TIMEOUT_MS: 30000,
} as const;

export const DYNAMIC_RENDERER_CONSTANTS = {
	NETWORK_BUDGET: {
		MAX_REQUESTS_PER_PAGE: 100,
		MAX_RESPONSE_BYTES_PER_PAGE: 20 * 1024 * 1024,
		MAX_CONCURRENT_SUBREQUESTS: 4,
		MIN_SUBREQUEST_DELAY_MS: 50,
	},
	VIEWPORT: { width: 1280, height: 720 },
	TIMEOUTS: {
		/** Time to wait for a clicked consent wall to disappear */
		CONSENT_CLEAR: 10000,
		/** Time to wait for a detected consent wall to become actionable */
		CONSENT_EVAL: 5000,
	},
} as const;

/**
 * Soft 404 detection thresholds.
 * Pages with HTTP 200 but "not found" content are flagged and skipped.
 */
export const SOFT_404_CONSTANTS = {
	/**
	 * Content-length in bytes below which an effectively empty page is flagged
	 * as a soft 404.
	 */
	TINY_CONTENT_BYTES: 500,
	/** Content-length below which keyword matching is also checked. */
	SHORT_CONTENT_BYTES: 3000,
	/** Keywords whose presence in title or short content indicates a soft 404. */
	KEYWORDS: [
		"404",
		"not found",
		"page not found",
		"does not exist",
		"page missing",
		"cannot be found",
		"no longer exists",
	] as readonly string[],
} as const;
