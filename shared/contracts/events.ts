import type {
	CrawlCompletedPayloadSchema,
	CrawlEventEnvelopeSchema,
	CrawlFailedPayloadSchema,
	CrawlLogPayloadSchema,
	CrawlPageEventPayloadSchema,
	CrawlPausedPayloadSchema,
	CrawlProgressPayloadSchema,
	CrawlStartedPayloadSchema,
	CrawlStoppedPayloadSchema,
} from "./schemas.js";

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
export type TerminalCrawlEventType = (typeof TERMINAL_CRAWL_EVENT_TYPE_VALUES)[number];
export type SettledCrawlEventType = (typeof SETTLED_CRAWL_EVENT_TYPE_VALUES)[number];

export type CrawlStartedPayload = typeof CrawlStartedPayloadSchema.static;
export type CrawlProgressPayload = typeof CrawlProgressPayloadSchema.static;
export type CrawlPagePayload = typeof CrawlPageEventPayloadSchema.static;
export type CrawlLogPayload = typeof CrawlLogPayloadSchema.static;
export type CrawlCompletedPayload = typeof CrawlCompletedPayloadSchema.static;
export type CrawlFailedPayload = typeof CrawlFailedPayloadSchema.static;
export type CrawlStoppedPayload = typeof CrawlStoppedPayloadSchema.static;
export type CrawlPausedPayload = typeof CrawlPausedPayloadSchema.static;

export type CrawlEventEnvelope = typeof CrawlEventEnvelopeSchema.static;

export type CrawlEventMap = {
	[TType in CrawlEventType]: Extract<CrawlEventEnvelope, { type: TType }>["payload"];
};

export type CrawlEventEnvelopeBase<TType extends CrawlEventType> = Omit<
	CrawlEventEnvelope,
	"type" | "payload"
> & {
	type: TType;
	payload: CrawlEventMap[TType];
};

export function isCrawlEventType(value: unknown): value is CrawlEventType {
	return typeof value === "string" && CrawlEventTypeValues.includes(value as CrawlEventType);
}

export function isLiveCrawlEventType(value: CrawlEventType): value is LiveCrawlEventType {
	return LIVE_CRAWL_EVENT_TYPE_VALUES.includes(value as LiveCrawlEventType);
}

export function isTerminalCrawlEventType(value: CrawlEventType): value is TerminalCrawlEventType {
	return TERMINAL_CRAWL_EVENT_TYPE_VALUES.includes(value as TerminalCrawlEventType);
}

export function isSettledCrawlEventType(value: CrawlEventType): value is SettledCrawlEventType {
	return SETTLED_CRAWL_EVENT_TYPE_VALUES.includes(value as SettledCrawlEventType);
}
