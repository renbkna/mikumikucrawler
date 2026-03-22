import type { CrawlOptions } from "../types.js";

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
