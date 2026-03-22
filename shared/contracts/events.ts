import type { CrawledPage, QueueStats } from "../types.js";
import type { CrawlCounters } from "./crawl.js";

export const CrawlEventTypeValues = [
	"crawl.started",
	"crawl.progress",
	"crawl.page",
	"crawl.log",
	"crawl.completed",
	"crawl.failed",
	"crawl.stopped",
] as const;

export type CrawlEventType = (typeof CrawlEventTypeValues)[number];

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

export interface CrawlEventMap {
	"crawl.started": CrawlStartedPayload;
	"crawl.progress": CrawlProgressPayload;
	"crawl.page": CrawlPagePayload;
	"crawl.log": CrawlLogPayload;
	"crawl.completed": CrawlCompletedPayload;
	"crawl.failed": CrawlFailedPayload;
	"crawl.stopped": CrawlStoppedPayload;
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
