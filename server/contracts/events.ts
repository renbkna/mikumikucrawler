import { t } from "elysia";
import { CrawlEventTypeValues } from "../../shared/contracts/events.js";
import { CrawlCountersSchema } from "./crawl.js";

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

const EventEnvelopeBaseSchema = {
	crawlId: t.String(),
	sequence: t.Number({ minimum: 1 }),
	timestamp: t.String({ format: "date-time" }),
};

const QueueStatsSchema = t.Object({
	activeRequests: t.Number({ minimum: 0 }),
	queueLength: t.Number({ minimum: 0 }),
	elapsedTime: t.Number({ minimum: 0 }),
	pagesPerSecond: t.Number({ minimum: 0 }),
});

const CrawlPagePayloadSchema = t.Object({
	id: t.Nullable(t.Number()),
	url: t.String(),
	content: t.Optional(t.String()),
	title: t.Optional(t.String()),
	description: t.Optional(t.String()),
	contentType: t.Optional(t.String()),
	domain: t.Optional(t.String()),
	processedData: t.Optional(t.Record(t.String(), t.Unknown())),
});

export const CrawlEventEnvelopeSchema = t.Union([
	t.Object({
		type: t.Literal("crawl.started"),
		...EventEnvelopeBaseSchema,
		payload: t.Object({
			target: t.String(),
			resume: t.Boolean(),
		}),
	}),
	t.Object({
		type: t.Literal("crawl.progress"),
		...EventEnvelopeBaseSchema,
		payload: t.Object({
			counters: CrawlCountersSchema,
			queue: QueueStatsSchema,
			elapsedSeconds: t.Number({ minimum: 0 }),
			pagesPerSecond: t.Number({ minimum: 0 }),
			stopReason: t.Nullable(t.String()),
		}),
	}),
	t.Object({
		type: t.Literal("crawl.page"),
		...EventEnvelopeBaseSchema,
		payload: CrawlPagePayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.log"),
		...EventEnvelopeBaseSchema,
		payload: t.Object({
			message: t.String(),
		}),
	}),
	t.Object({
		type: t.Literal("crawl.completed"),
		...EventEnvelopeBaseSchema,
		payload: t.Object({
			counters: CrawlCountersSchema,
		}),
	}),
	t.Object({
		type: t.Literal("crawl.failed"),
		...EventEnvelopeBaseSchema,
		payload: t.Object({
			error: t.String(),
			counters: CrawlCountersSchema,
		}),
	}),
	t.Object({
		type: t.Literal("crawl.stopped"),
		...EventEnvelopeBaseSchema,
		payload: t.Object({
			stopReason: t.String(),
			counters: CrawlCountersSchema,
		}),
	}),
]);
