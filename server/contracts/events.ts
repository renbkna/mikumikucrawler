import { t } from "elysia";

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

export const CrawlEventTypeSchema = t.Union(
	CrawlEventTypeValues.map((value) => t.Literal(value)),
);

export const CrawlEventEnvelopeSchema = t.Object({
	type: CrawlEventTypeSchema,
	crawlId: t.String(),
	sequence: t.Number({ minimum: 1 }),
	timestamp: t.String({ format: "date-time" }),
	payload: t.Record(t.String(), t.Unknown()),
});

export type CrawlEventEnvelope = typeof CrawlEventEnvelopeSchema.static;
