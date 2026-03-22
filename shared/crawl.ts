/**
 * Shared crawl-option contract used by both the frontend and backend.
 * This prevents UI controls and server validation from drifting apart.
 */
export const CRAWL_METHODS = ["links", "media", "full"] as const;

export type CrawlMethod = (typeof CRAWL_METHODS)[number];

export const CRAWL_OPTION_BOUNDS = {
	crawlDepth: { min: 1, max: 5 },
	crawlDelay: { min: 200, max: 10_000, step: 250 },
	maxPages: { min: 1, max: 200 },
	maxPagesPerDomain: { min: 0, max: 1000 },
	maxConcurrentRequests: { min: 1, max: 10 },
	retryLimit: { min: 0, max: 5 },
} as const;

export function isCrawlMethod(value: string): value is CrawlMethod {
	return CRAWL_METHODS.includes(value as CrawlMethod);
}
