import { CRAWL_PAGE_SNAPSHOT_LIMIT } from "../shared/contracts/index.js";

export const CRAWLER_DEFAULTS = {
	CRAWL_METHOD: "full" as const,
	CRAWL_DEPTH: 2,
	CRAWL_DELAY: 1000,
	MAX_PAGES: 50,
	/** 0 = unlimited per-domain */
	MAX_PAGES_PER_DOMAIN: 0,
	MAX_CONCURRENT_REQUESTS: 5,
	RETRY_LIMIT: 3,
	DYNAMIC: true,
	RESPECT_ROBOTS: true,
	CONTENT_ONLY: false,
	SAVE_MEDIA: false,
} as const;

export const UI_LIMITS = {
	MAX_PAGE_BUFFER: CRAWL_PAGE_SNAPSHOT_LIMIT,
	MAX_LOGS: 100,
} as const;

export const TOAST_DEFAULTS = {
	DEFAULT_TIMEOUT: 3000,
	LONG_TIMEOUT: 5000,
	EXIT_ANIMATION_MS: 300,
} as const;

export const SEQUENCE_TIMINGS = {
	COUNT_1: 5400,
	COUNT_2: 6650,
	COUNT_3: 7800,
	READY: 8900,
	COMPLETE: 10200,
};
