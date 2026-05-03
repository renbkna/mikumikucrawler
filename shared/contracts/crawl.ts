import { t } from "elysia";
import {
	CRAWL_OPTION_BOUNDS,
	type CrawlMethod,
	isCrawlMethod,
} from "../crawl.js";

export const DEFAULT_CRAWL_LIST_LIMIT = 25;

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isIntegerInRange(
	value: unknown,
	bounds: { min: number; max: number },
): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= bounds.min &&
		value <= bounds.max
	);
}

export function isCrawlOptions(value: unknown): value is CrawlOptions {
	return (
		isRecord(value) &&
		typeof value.target === "string" &&
		value.target.length > 0 &&
		typeof value.crawlMethod === "string" &&
		isCrawlMethod(value.crawlMethod) &&
		isIntegerInRange(value.crawlDepth, CRAWL_OPTION_BOUNDS.crawlDepth) &&
		isIntegerInRange(value.crawlDelay, CRAWL_OPTION_BOUNDS.crawlDelay) &&
		isIntegerInRange(value.maxPages, CRAWL_OPTION_BOUNDS.maxPages) &&
		isIntegerInRange(
			value.maxPagesPerDomain,
			CRAWL_OPTION_BOUNDS.maxPagesPerDomain,
		) &&
		isIntegerInRange(
			value.maxConcurrentRequests,
			CRAWL_OPTION_BOUNDS.maxConcurrentRequests,
		) &&
		isIntegerInRange(value.retryLimit, CRAWL_OPTION_BOUNDS.retryLimit) &&
		typeof value.dynamic === "boolean" &&
		typeof value.respectRobots === "boolean" &&
		typeof value.contentOnly === "boolean" &&
		typeof value.saveMedia === "boolean"
	);
}

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
	return (
		typeof value === "string" &&
		CrawlStatusValues.includes(value as CrawlStatus)
	);
}

export const PENDING_CRAWL_STATUS_VALUES = ["pending"] as const;

export const ACTIVE_CRAWL_STATUS_VALUES = [
	"starting",
	"running",
	"pausing",
	"stopping",
] as const;

export const RESUMABLE_CRAWL_STATUS_VALUES = ["paused", "interrupted"] as const;

export const TERMINAL_CRAWL_STATUS_VALUES = [
	"completed",
	"stopped",
	"failed",
] as const;

export function isPendingCrawlStatus(status: CrawlStatus): boolean {
	return PENDING_CRAWL_STATUS_VALUES.includes(
		status as (typeof PENDING_CRAWL_STATUS_VALUES)[number],
	);
}

export function isActiveCrawlStatus(status: CrawlStatus): boolean {
	return ACTIVE_CRAWL_STATUS_VALUES.includes(
		status as (typeof ACTIVE_CRAWL_STATUS_VALUES)[number],
	);
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

export interface CrawlCounters {
	pagesScanned: number;
	successCount: number;
	failureCount: number;
	skippedCount: number;
	linksFound: number;
	mediaFiles: number;
	totalDataKb: number;
}

export const CrawlCountersSchema = t.Object({
	pagesScanned: t.Number({ minimum: 0 }),
	successCount: t.Number({ minimum: 0 }),
	failureCount: t.Number({ minimum: 0 }),
	skippedCount: t.Number({ minimum: 0 }),
	linksFound: t.Number({ minimum: 0 }),
	mediaFiles: t.Number({ minimum: 0 }),
	totalDataKb: t.Number({ minimum: 0 }),
});

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isCrawlCounters(value: unknown): value is CrawlCounters {
	return (
		isRecord(value) &&
		isNonNegativeFiniteNumber(value.pagesScanned) &&
		isNonNegativeFiniteNumber(value.successCount) &&
		isNonNegativeFiniteNumber(value.failureCount) &&
		isNonNegativeFiniteNumber(value.skippedCount) &&
		isNonNegativeFiniteNumber(value.linksFound) &&
		isNonNegativeFiniteNumber(value.mediaFiles) &&
		isNonNegativeFiniteNumber(value.totalDataKb)
	);
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

export interface CrawlListResponse {
	crawls: CrawlSummary[];
}

export function isCrawlSummary(value: unknown): value is CrawlSummary {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.target === "string" &&
		isCrawlStatus(value.status) &&
		isCrawlOptions(value.options) &&
		isCrawlCounters(value.counters) &&
		typeof value.createdAt === "string" &&
		(value.startedAt === null || typeof value.startedAt === "string") &&
		typeof value.updatedAt === "string" &&
		(value.completedAt === null || typeof value.completedAt === "string") &&
		(value.stopReason === null || typeof value.stopReason === "string") &&
		typeof value.resumable === "boolean"
	);
}

export function isCrawlListResponse(
	value: unknown,
): value is CrawlListResponse {
	return (
		isRecord(value) &&
		Array.isArray(value.crawls) &&
		value.crawls.every(isCrawlSummary)
	);
}

export interface ResumableSessionSummary {
	id: string;
	target: string;
	status: CrawlStatus;
	pagesScanned: number;
	createdAt: string;
	updatedAt: string;
}

export function toResumableSessionSummary(
	crawl: CrawlSummary,
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
