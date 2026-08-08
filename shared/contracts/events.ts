import type { Static } from "typebox";
import type { CrawlEventEnvelopeSchema } from "./schemas.js";

export const CRAWL_EVENT_TYPES = {
	started: "crawl.started",
	progress: "crawl.progress",
	page: "crawl.page",
	log: "crawl.log",
	completed: "crawl.completed",
	failed: "crawl.failed",
	stopped: "crawl.stopped",
	paused: "crawl.paused",
} as const;

export const CrawlEventTypeValues = Object.values(CRAWL_EVENT_TYPES);

export type CrawlEventType = (typeof CRAWL_EVENT_TYPES)[keyof typeof CRAWL_EVENT_TYPES];

export const SETTLED_CRAWL_EVENT_TYPE_VALUES = [
	CRAWL_EVENT_TYPES.completed,
	CRAWL_EVENT_TYPES.failed,
	CRAWL_EVENT_TYPES.stopped,
	CRAWL_EVENT_TYPES.paused,
] as const;

export type SettledCrawlEventType = (typeof SETTLED_CRAWL_EVENT_TYPE_VALUES)[number];

export type CrawlEventEnvelope = Static<typeof CrawlEventEnvelopeSchema>;

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

export function isSettledCrawlEventType(value: CrawlEventType): value is SettledCrawlEventType {
	return SETTLED_CRAWL_EVENT_TYPE_VALUES.includes(value as SettledCrawlEventType);
}
