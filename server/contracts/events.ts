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
	CrawlPausedPayload,
	CrawlProgressPayload,
	CrawlStartedPayload,
	CrawlStoppedPayload,
} from "../../shared/contracts/events.js";

export const CrawlEventTypeSchema = t.Union(
	CrawlEventTypeValues.map((value) => t.Literal(value)),
);

const EventEnvelopeBaseSchema = {
	crawlId: t.String(),
	sequence: t.Number({ minimum: 1, multipleOf: 1 }),
	timestamp: t.String({ format: "date-time" }),
};

const QueueStatsSchema = t.Object({
	activeRequests: t.Number({ minimum: 0 }),
	queueLength: t.Number({ minimum: 0 }),
	elapsedTime: t.Number({ minimum: 0 }),
	pagesPerSecond: t.Number({ minimum: 0 }),
});

const ProcessedPageDataSchema = t.Object({
	extractedData: t.Object({
		mainContent: t.Optional(t.String()),
		jsonLd: t.Optional(t.Array(t.Record(t.String(), t.Unknown()))),
		microdata: t.Optional(t.Record(t.String(), t.Unknown())),
		openGraph: t.Optional(t.Record(t.String(), t.String())),
		twitterCards: t.Optional(t.Record(t.String(), t.String())),
		schema: t.Optional(t.Record(t.String(), t.Unknown())),
	}),
	metadata: t.Record(t.String(), t.String()),
	analysis: t.Object({
		wordCount: t.Optional(t.Number({ minimum: 0 })),
		readingTime: t.Optional(t.Number({ minimum: 0 })),
		language: t.Optional(t.String()),
		keywords: t.Optional(
			t.Array(
				t.Object({
					word: t.String(),
					count: t.Number({ minimum: 0 }),
				}),
			),
		),
		sentiment: t.Optional(t.String()),
		readabilityScore: t.Optional(t.Number()),
		quality: t.Optional(
			t.Object({
				score: t.Number(),
				factors: t.Record(t.String(), t.Union([t.Number(), t.Boolean()])),
				issues: t.Array(t.String()),
			}),
		),
	}),
	media: t.Array(
		t.Object({
			type: t.Union([
				t.Literal("image"),
				t.Literal("video"),
				t.Literal("audio"),
			]),
			url: t.String(),
			alt: t.Optional(t.String()),
			title: t.Optional(t.String()),
			width: t.Optional(t.String()),
			height: t.Optional(t.String()),
			poster: t.Optional(t.String()),
		}),
	),
	errors: t.Optional(
		t.Array(
			t.Object({
				type: t.String(),
				message: t.String(),
				timestamp: t.Optional(t.String()),
			}),
		),
	),
	qualityScore: t.Number(),
	language: t.String(),
});

const CrawlPagePayloadSchema = t.Object({
	id: t.Nullable(t.Number({ multipleOf: 1 })),
	url: t.String(),
	content: t.Optional(t.String()),
	title: t.Optional(t.String()),
	description: t.Optional(t.String()),
	contentType: t.Optional(t.String()),
	domain: t.Optional(t.String()),
	processedData: t.Optional(ProcessedPageDataSchema),
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
	t.Object({
		type: t.Literal("crawl.paused"),
		...EventEnvelopeBaseSchema,
		payload: t.Object({
			stopReason: t.Nullable(t.String()),
			counters: CrawlCountersSchema,
		}),
	}),
]);
