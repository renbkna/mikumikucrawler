import type { Static } from "typebox";
import type {
	CrawlCountersSchema,
	CrawlOptionsSchema,
	CrawlRecoverySnapshotSchema,
	CrawlSummarySchema,
	ResumableCrawlListResponseSchema,
} from "./schemas.js";

export const DEFAULT_CRAWL_LIST_LIMIT = 25;

export type CrawlOptions = Static<typeof CrawlOptionsSchema>;

export function crawlOptionsEqual(left: CrawlOptions, right: CrawlOptions): boolean {
	const keys = Object.keys(left) as Array<keyof CrawlOptions>;
	return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

export const ACTIVE_CRAWL_STATUS_VALUES = [
	"pending",
	"starting",
	"running",
	"pausing",
	"stopping",
] as const;

export const RESUMABLE_CRAWL_STATUS_VALUES = ["paused", "interrupted"] as const;

export const TERMINAL_CRAWL_STATUS_VALUES = ["completed", "stopped", "failed"] as const;

export const CrawlStatusValues = [
	...ACTIVE_CRAWL_STATUS_VALUES,
	...RESUMABLE_CRAWL_STATUS_VALUES,
	...TERMINAL_CRAWL_STATUS_VALUES,
] as const;

export type CrawlStatus = (typeof CrawlStatusValues)[number];
export type ActiveCrawlStatus = (typeof ACTIVE_CRAWL_STATUS_VALUES)[number];
export type ResumableCrawlStatus = (typeof RESUMABLE_CRAWL_STATUS_VALUES)[number];

export function isActiveCrawlStatus(status: CrawlStatus): status is ActiveCrawlStatus {
	return ACTIVE_CRAWL_STATUS_VALUES.includes(status as (typeof ACTIVE_CRAWL_STATUS_VALUES)[number]);
}

export function isResumableCrawlStatus(status: CrawlStatus): status is ResumableCrawlStatus {
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

export type CrawlCounters = Static<typeof CrawlCountersSchema>;

export function createEmptyCrawlCounters(): CrawlCounters {
	return {
		pagesScanned: 0,
		successCount: 0,
		failureCount: 0,
		skippedCount: 0,
		linksFound: 0,
		mediaFiles: 0,
		totalDataKb: 0,
	};
}

export type CrawlSummary = Static<typeof CrawlSummarySchema>;
export type CrawlRecoverySnapshot = Static<typeof CrawlRecoverySnapshotSchema>;
export type ResumableCrawlListResponse = Static<typeof ResumableCrawlListResponseSchema>;

export interface ResumableSessionSummary {
	id: string;
	target: string;
	status: ResumableCrawlStatus;
	pagesScanned: number;
	createdAt: string;
	updatedAt: string;
}

export function toResumableSessionSummary(
	crawl: ResumableCrawlListResponse["crawls"][number],
): ResumableSessionSummary {
	return {
		id: crawl.id,
		target: crawl.target,
		status: crawl.status,
		pagesScanned: crawl.counters.pagesScanned,
		createdAt: crawl.createdAt,
		updatedAt: crawl.updatedAt,
	};
}
