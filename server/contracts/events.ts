import { t } from "elysia";
import { CrawlEventTypeValues } from "../../shared/contracts/events.js";

// Re-export shared types for server consumers
export { CrawlEventTypeValues } from "../../shared/contracts/events.js";
export type {
	CrawlCompletedPayload,
	CrawlEventEnvelope,
	CrawlEventEnvelopeBase,
	CrawlEventMap,
	CrawlEventType,
	CrawlFailedPayload,
	CrawlLogPayload,
	CrawlPagePayload,
	CrawlProgressPayload,
	CrawlStartedPayload,
	CrawlStoppedPayload,
} from "../../shared/contracts/events.js";

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
