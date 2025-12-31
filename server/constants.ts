export const CRAWL_QUEUE_CONSTANTS = {
	DOMAIN_CACHE_CLEANUP_THRESHOLD: 500,
	DOMAIN_ENTRY_EXPIRY_MS: 60000,
	DEFAULT_SLEEP_MS: 100,
	MIN_SLEEP_MS: 50,
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
	/** Memory threshold in MB for Puppeteer constraints */
	HEAP_THRESHOLD_MB: 400,
	/** Maximum entries in robots.txt cache */
	ROBOTS_CACHE_MAX_SIZE: 100,
	/** TTL for robots.txt cache entries in ms (1 hour) */
	ROBOTS_CACHE_TTL_MS: 60 * 60 * 1000,
} as const;

/** Batch processing configuration */
export const BATCH_CONSTANTS = {
	/** Concurrency limit for link batch processing */
	LINK_BATCH_CONCURRENCY: 10,
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
	},
} as const;

/**
 * Site-specific CSS selectors for waiting on complex JS-rendered pages.
 * These selectors indicate that the main content has finished loading.
 * Key: URL pattern to match, Value: CSS selector to wait for
 */
export const SITE_SELECTORS: Record<string, string> = {
	"youtube.com/watch": "h1.ytd-video-primary-info-renderer",
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
