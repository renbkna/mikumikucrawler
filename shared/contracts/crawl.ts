import type { CrawlMethod } from "../crawl.js";

export interface CrawlOptions {
	target: string;
	crawlMethod: CrawlMethod;
	crawlDepth: number;
	crawlDelay: number;
	maxPages: number;
	/** Maximum pages to crawl per domain. 0 means unlimited. */
	maxPagesPerDomain: number;
	maxConcurrentRequests: number;
	retryLimit: number;
	dynamic: boolean;
	respectRobots: boolean;
	contentOnly: boolean;
	saveMedia: boolean;
}

export const CrawlStatusValues = [
	"pending",
	"starting",
	"running",
	"stopping",
	"completed",
	"stopped",
	"failed",
	"interrupted",
] as const;

export type CrawlStatus = (typeof CrawlStatusValues)[number];

export interface CrawlCounters {
	pagesScanned: number;
	successCount: number;
	failureCount: number;
	skippedCount: number;
	linksFound: number;
	mediaFiles: number;
	totalDataKb: number;
}

export interface CrawlSummary {
	id: string;
	target: string;
	status: CrawlStatus;
	options: CrawlOptions;
	counters: CrawlCounters;
	createdAt: string;
	startedAt: string | null;
	updatedAt: string;
	completedAt: string | null;
	stopReason: string | null;
	resumable: boolean;
}
