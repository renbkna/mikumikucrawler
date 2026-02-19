export const CRAWL_QUEUE_CONSTANTS = {
	DOMAIN_CACHE_CLEANUP_THRESHOLD: 500,
	DOMAIN_ENTRY_EXPIRY_MS: 60000,
	DEFAULT_SLEEP_MS: 100,
	MIN_SLEEP_MS: 50,
	/** Number of consumed head slots before the queue array is compacted */
	QUEUE_COMPACTION_THRESHOLD: 1000,
	/** Maximum time to process a single queue item before timeout (60 seconds - reduced from 90) */
	ITEM_PROCESSING_TIMEOUT_MS: 60000,
	/** Interval for stuck detection watchdog checks (15 seconds - more frequent) */
	STUCK_DETECTION_INTERVAL_MS: 15000,
	/** Time without progress before warning about potential stuck state (30 seconds) */
	STUCK_WARNING_THRESHOLD_MS: 30000,
	/** Time without progress before force-clearing stuck items (90 seconds - more aggressive) */
	STUCK_FORCE_CLEAR_THRESHOLD_MS: 90000,
} as const;

export const TIMEOUT_CONSTANTS = {
	STATIC_FETCH: 10000, // 10s for HTTP requests
	DYNAMIC_RENDER: 30000, // 30s for Puppeteer
	CONTENT_PROCESSING: 5000, // 5s for HTML parsing/analysis
	DATABASE_OPERATION: 10000, // 10s for DB queries
} as const;

export const RETRY_CONSTANTS = {
	BASE_DELAY: 1000,
	MAX_DELAY: 30000,
} as const;

/** Standard HTTP headers for crawling requests */
export const FETCH_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
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
	/** Maximum URL length for validation (2000 characters) */
	MAX_URL_LENGTH: 2000,
} as const;

/** Export configuration */
export const EXPORT_CONSTANTS = {
	/** Number of rows per chunk for data export */
	CHUNK_SIZE: 500,
} as const;

/** Batch processing configuration */
export const BATCH_CONSTANTS = {
	/** Concurrency limit for link batch processing */
	LINK_BATCH_CONCURRENCY: 10,
} as const;

/** PDF processing limits to prevent resource exhaustion */
export const PDF_CONSTANTS = {
	/** Maximum number of pages to process per PDF (prevents memory exhaustion) */
	MAX_PAGES: 1000,
	/** Maximum file size in MB */
	MAX_FILE_SIZE_MB: 50,
	/** Timeout for PDF processing in ms (30 seconds) */
	PROCESSING_TIMEOUT_MS: 30000,
} as const;

/** WebSocket rate limiting configuration */
export const WEBSOCKET_RATE_LIMIT = {
	/** Maximum messages per minute per socket */
	MAX_MESSAGES_PER_MINUTE: 100,
	/** Window size in ms (1 minute) */
	WINDOW_MS: 60000,
} as const;

export const DYNAMIC_RENDERER_CONSTANTS = {
	COMPLEX_JS_SITES: [
		"youtube.com",
		"google.com",
		"facebook.com",
		"meta.com",
		"twitter.com",
		"x.com",
		"instagram.com",
		"linkedin.com",
		"discord.com",
		"reddit.com",
		"pinterest.com",
		"tiktok.com",
		"netflix.com",
		"amazon.com",
		"airbnb.com",
		"uber.com",
		"spotify.com",
		"github.com",
		"stackoverflow.com",
		"medium.com",
		"twitch.tv",
		"salesforce.com",
		"slack.com",
		"notion.so",
		"figma.com",
		"canva.com",
		"trello.com",
		"asana.com",
		"dropbox.com",
		"zoom.us",
	],
	VIEWPORT: { width: 1280, height: 720 },
	RECYCLE_THRESHOLD: {
		DEFAULT: 200,
		RENDER_ENV: 50,
	},
	TIMEOUTS: {
		COMPLEX_NAVIGATION: 60000,
		STANDARD_NAVIGATION: 30000,
		SELECTOR_WAIT: 15000,
		ADDITIONAL_WAIT: 2000,
		/** Time to wait for navigation after consent bypass click */
		CONSENT_NAVIGATION: 10000,
		/** Time to wait for consent modal detection/interaction */
		CONSENT_EVAL: 5000,
	},
} as const;

/**
 * Site-specific CSS selectors for waiting on complex JS-rendered pages.
 * These selectors indicate that the main content has finished loading.
 * Key: URL pattern to match, Value: CSS selector to wait for
 */
export const SITE_SELECTORS: Record<string, string> = {
	"youtube.com/watch": "h1.ytd-video-primary-info-renderer",
	"youtube.com/@": "ytd-rich-grid-media, #video-title",
	"twitter.com": '[data-testid="tweet"]',
	"x.com": '[data-testid="tweet"]',
	"linkedin.com": ".feed-container-theme",
	"instagram.com": '[role="main"]',
	"reddit.com": '[data-testid="post-container"]',
	"facebook.com": '[role="main"]',
	"meta.com": '[role="main"]',
	"github.com": ".js-repo-root, .repository-content",
	"medium.com": "article",
	"stackoverflow.com": ".question, .answer",
};

/**
 * Site-specific cookies to set before navigation.
 * Used to bypass consent dialogs, age verification, etc.
 */
export const SITE_COOKIES: Record<
	string,
	Array<{ name: string; value: string }>
> = {
	"youtube.com": [
		{ name: "CONSENT", value: "YES+" },
		{ name: "PREF", value: "tz=UTC" },
	],
	"reddit.com": [{ name: "over18", value: "1" }],
};

/**
 * Soft 404 detection thresholds.
 * Pages with HTTP 200 but "not found" content are flagged and skipped.
 */
export const SOFT_404_CONSTANTS = {
	/** Content-length in bytes below which a page is unconditionally flagged as soft 404. */
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

/**
 * Adaptive throttle thresholds.
 * The crawler adjusts per-domain delays based on observed response times.
 */
export const ADAPTIVE_THROTTLE = {
	/** Response time in ms above which the domain delay is increased. */
	SLOW_RESPONSE_MS: 3000,
	/** Response time in ms below which the domain delay may be decreased. */
	FAST_RESPONSE_MS: 500,
	/** Multiplier applied to delay when a slow response is observed (delay × factor). */
	SLOW_FACTOR: 1.5,
	/** Multiplier applied to delay when a fast response is observed (delay × factor). */
	FAST_FACTOR: 0.9,
	/** Absolute maximum delay the adaptive system can set (ms). */
	MAX_DELAY_MS: 30_000,
} as const;

/** Sitemap discovery and parsing configuration */
export const SITEMAP_CONSTANTS = {
	/** Maximum total URLs to collect from all sitemaps (prevents memory exhaustion) */
	MAX_ENTRIES: 5000,
	/** Fetch timeout for sitemap requests in ms */
	FETCH_TIMEOUT_MS: 10000,
	/** Maximum sitemap index recursion depth (sitemap → sitemap index → ...) */
	MAX_RECURSION_DEPTH: 3,
} as const;
