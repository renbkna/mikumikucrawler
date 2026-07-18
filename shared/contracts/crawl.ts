import type {
	CrawlCountersSchema,
	CrawlListResponseSchema,
	CrawlOptionsSchema,
	CrawlRecoverySnapshotSchema,
	CrawlSummarySchema,
} from "./schemas.js";

export const DEFAULT_CRAWL_LIST_LIMIT = 25;

export type CrawlOptions = typeof CrawlOptionsSchema.static;

export const CrawlStatusValues = [
	"pending",
	"starting",
	"running",
	"pausing",
	"paused",
	"stopping",
	"completed",
	"stopped",
	"failed",
	"interrupted",
] as const;

export type CrawlStatus = (typeof CrawlStatusValues)[number];

export function isCrawlStatus(value: unknown): value is CrawlStatus {
	return typeof value === "string" && CrawlStatusValues.includes(value as CrawlStatus);
}

export const PENDING_CRAWL_STATUS_VALUES = ["pending"] as const;

export const ACTIVE_CRAWL_STATUS_VALUES = [
	"pending",
	"starting",
	"running",
	"pausing",
	"stopping",
] as const;

export const RESUMABLE_CRAWL_STATUS_VALUES = ["paused", "interrupted"] as const;

export const TERMINAL_CRAWL_STATUS_VALUES = ["completed", "stopped", "failed"] as const;

export function isPendingCrawlStatus(status: CrawlStatus): boolean {
	return PENDING_CRAWL_STATUS_VALUES.includes(
		status as (typeof PENDING_CRAWL_STATUS_VALUES)[number],
	);
}

export function isActiveCrawlStatus(status: CrawlStatus): boolean {
	return ACTIVE_CRAWL_STATUS_VALUES.includes(status as (typeof ACTIVE_CRAWL_STATUS_VALUES)[number]);
}

export function isResumableCrawlStatus(status: CrawlStatus): boolean {
	return RESUMABLE_CRAWL_STATUS_VALUES.includes(
		status as (typeof RESUMABLE_CRAWL_STATUS_VALUES)[number],
	);
}

export function isTerminalCrawlStatus(status: CrawlStatus): boolean {
	return TERMINAL_CRAWL_STATUS_VALUES.includes(
		status as (typeof TERMINAL_CRAWL_STATUS_VALUES)[number],
	);
}

export const StopCrawlModeValues = ["pause", "force"] as const;

export type StopCrawlMode = (typeof StopCrawlModeValues)[number];

export type CrawlCounters = typeof CrawlCountersSchema.static;
export type CrawlSummary = typeof CrawlSummarySchema.static;
export type CrawlListResponse = typeof CrawlListResponseSchema.static;
export type CrawlRecoverySnapshot = typeof CrawlRecoverySnapshotSchema.static;

export interface ResumableSessionSummary {
	id: string;
	target: string;
	status: CrawlStatus;
	pagesScanned: number;
	createdAt: string;
	updatedAt: string;
}

export function toResumableSessionSummary(crawl: CrawlSummary): ResumableSessionSummary {
	return {
		id: crawl.id,
		target: crawl.target,
		status: crawl.status,
		pagesScanned: crawl.counters.pagesScanned,
		createdAt: crawl.createdAt,
		updatedAt: crawl.updatedAt,
	};
}
