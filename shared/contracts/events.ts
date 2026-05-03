import type { CrawlCounters } from "./crawl.js";
import type { CrawledPage, QueueStats } from "./pageData.js";

export const CrawlEventTypeValues = [
	"crawl.started",
	"crawl.progress",
	"crawl.page",
	"crawl.log",
	"crawl.completed",
	"crawl.failed",
	"crawl.stopped",
	"crawl.paused",
] as const;

export type CrawlEventType = (typeof CrawlEventTypeValues)[number];

export const LIVE_CRAWL_EVENT_TYPE_VALUES = [
	"crawl.started",
	"crawl.progress",
	"crawl.page",
	"crawl.log",
] as const;

export const TERMINAL_CRAWL_EVENT_TYPE_VALUES = [
	"crawl.completed",
	"crawl.failed",
	"crawl.stopped",
] as const;

export const SETTLED_CRAWL_EVENT_TYPE_VALUES = [
	...TERMINAL_CRAWL_EVENT_TYPE_VALUES,
	"crawl.paused",
] as const;

export type LiveCrawlEventType = (typeof LIVE_CRAWL_EVENT_TYPE_VALUES)[number];
export type TerminalCrawlEventType =
	(typeof TERMINAL_CRAWL_EVENT_TYPE_VALUES)[number];
export type SettledCrawlEventType =
	(typeof SETTLED_CRAWL_EVENT_TYPE_VALUES)[number];

export interface CrawlStartedPayload {
	target: string;
	resume: boolean;
}

export interface CrawlProgressPayload {
	counters: CrawlCounters;
	queue: QueueStats;
	elapsedSeconds: number;
	pagesPerSecond: number;
	stopReason: string | null;
}

export type CrawlPagePayload = CrawledPage;

export interface CrawlLogPayload {
	message: string;
}

export interface CrawlCompletedPayload {
	counters: CrawlCounters;
}

export interface CrawlFailedPayload {
	error: string;
	counters: CrawlCounters;
}

export interface CrawlStoppedPayload {
	stopReason: string;
	counters: CrawlCounters;
}

export interface CrawlPausedPayload {
	stopReason: string | null;
	counters: CrawlCounters;
}

export interface CrawlEventMap {
	"crawl.started": CrawlStartedPayload;
	"crawl.progress": CrawlProgressPayload;
	"crawl.page": CrawlPagePayload;
	"crawl.log": CrawlLogPayload;
	"crawl.completed": CrawlCompletedPayload;
	"crawl.failed": CrawlFailedPayload;
	"crawl.stopped": CrawlStoppedPayload;
	"crawl.paused": CrawlPausedPayload;
}

export interface CrawlEventEnvelopeBase<TType extends CrawlEventType> {
	type: TType;
	crawlId: string;
	sequence: number;
	timestamp: string;
	payload: CrawlEventMap[TType];
}

export type CrawlEventEnvelope = {
	[TType in CrawlEventType]: CrawlEventEnvelopeBase<TType>;
}[CrawlEventType];

export function isCrawlEventType(value: unknown): value is CrawlEventType {
	return (
		typeof value === "string" &&
		CrawlEventTypeValues.includes(value as CrawlEventType)
	);
}

export function isLiveCrawlEventType(
	value: CrawlEventType,
): value is LiveCrawlEventType {
	return LIVE_CRAWL_EVENT_TYPE_VALUES.includes(value as LiveCrawlEventType);
}

export function isTerminalCrawlEventType(
	value: CrawlEventType,
): value is TerminalCrawlEventType {
	return TERMINAL_CRAWL_EVENT_TYPE_VALUES.includes(
		value as TerminalCrawlEventType,
	);
}

export function isSettledCrawlEventType(
	value: CrawlEventType,
): value is SettledCrawlEventType {
	return SETTLED_CRAWL_EVENT_TYPE_VALUES.includes(
		value as SettledCrawlEventType,
	);
}
