import { t } from "elysia/type-system";
import { CRAWL_METHODS, CRAWL_OPTION_BOUNDS } from "../crawl.js";
import { CRAWL_EXPORT_FORMAT_VALUES } from "./api.js";
import {
	CrawlEventTypeValues,
	LIVE_CRAWL_EVENT_TYPE_VALUES,
	SETTLED_CRAWL_EVENT_TYPE_VALUES,
	TERMINAL_CRAWL_EVENT_TYPE_VALUES,
} from "./events.js";
import {
	DEFAULT_CRAWL_LIST_LIMIT,
	CrawlStatusValues,
	StopCrawlModeValues,
} from "./crawl.js";
import { optionalBoundedListLimitSchema } from "./http.js";
import { MediaTypeValues } from "./pageData.js";

export const CrawlStatusSchema = t.UnionEnum([...CrawlStatusValues]);

export const CrawlMethodValues = CRAWL_METHODS;
export type CrawlMethod = (typeof CrawlMethodValues)[number];
export const CrawlMethodSchema = t.UnionEnum([...CrawlMethodValues]);

export const StopCrawlModeSchema = t.UnionEnum([...StopCrawlModeValues]);

export const CrawlOptionsSchema = t.Object({
	target: t.String({ minLength: 1 }),
	crawlMethod: CrawlMethodSchema,
	crawlDepth: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.crawlDepth.min,
		maximum: CRAWL_OPTION_BOUNDS.crawlDepth.max,
		multipleOf: 1,
	}),
	crawlDelay: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.crawlDelay.min,
		maximum: CRAWL_OPTION_BOUNDS.crawlDelay.max,
		multipleOf: 1,
	}),
	maxPages: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.maxPages.min,
		maximum: CRAWL_OPTION_BOUNDS.maxPages.max,
		multipleOf: 1,
	}),
	maxPagesPerDomain: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.maxPagesPerDomain.min,
		maximum: CRAWL_OPTION_BOUNDS.maxPagesPerDomain.max,
		multipleOf: 1,
	}),
	maxConcurrentRequests: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.maxConcurrentRequests.min,
		maximum: CRAWL_OPTION_BOUNDS.maxConcurrentRequests.max,
		multipleOf: 1,
	}),
	retryLimit: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.retryLimit.min,
		maximum: CRAWL_OPTION_BOUNDS.retryLimit.max,
		multipleOf: 1,
	}),
	dynamic: t.Boolean(),
	respectRobots: t.Boolean(),
	contentOnly: t.Boolean(),
	saveMedia: t.Boolean(),
});

export type CrawlOptions = typeof CrawlOptionsSchema.static;

export const CrawlCountersSchema = t.Object({
	pagesScanned: t.Number({ minimum: 0 }),
	successCount: t.Number({ minimum: 0 }),
	failureCount: t.Number({ minimum: 0 }),
	skippedCount: t.Number({ minimum: 0 }),
	linksFound: t.Number({ minimum: 0 }),
	mediaFiles: t.Number({ minimum: 0 }),
	totalDataKb: t.Number({ minimum: 0 }),
});

export const CrawlSummarySchema = t.Object({
	id: t.String(),
	target: t.String(),
	status: CrawlStatusSchema,
	options: CrawlOptionsSchema,
	counters: CrawlCountersSchema,
	createdAt: t.String({ format: "date-time" }),
	startedAt: t.Nullable(t.String({ format: "date-time" })),
	updatedAt: t.String({ format: "date-time" }),
	completedAt: t.Nullable(t.String({ format: "date-time" })),
	stopReason: t.Nullable(t.String()),
	resumable: t.Boolean(),
});

export const CrawlListQuerySchema = t.Object({
	status: t.Optional(CrawlStatusSchema),
	from: t.Optional(t.String({ format: "date-time" })),
	to: t.Optional(t.String({ format: "date-time" })),
	limit: optionalBoundedListLimitSchema(DEFAULT_CRAWL_LIST_LIMIT),
});

export const CrawlListResponseSchema = t.Object({
	crawls: t.Array(CrawlSummarySchema),
});

export const ResumableCrawlListQuerySchema = t.Object({
	limit: optionalBoundedListLimitSchema(DEFAULT_CRAWL_LIST_LIMIT),
});

export const ResumableCrawlListResponseSchema = CrawlListResponseSchema;

export const CreateCrawlResponseSchema = CrawlSummarySchema;
export const StopCrawlResponseSchema = CrawlSummarySchema;
export const ResumeCrawlResponseSchema = CrawlSummarySchema;
export const GetCrawlResponseSchema = CrawlSummarySchema;

export const CreateCrawlBodySchema = CrawlOptionsSchema;

export const StopCrawlBodySchema = t.Optional(
	t.Object({
		mode: t.Optional(StopCrawlModeSchema),
	}),
);

export const CrawlIdParamsSchema = t.Object({
	id: t.String(),
});

export const ExportQuerySchema = t.Object({
	format: t.Optional(
		t.Union(CRAWL_EXPORT_FORMAT_VALUES.map((value) => t.Literal(value))),
	),
});

export const PageContentResponseSchema = t.Object({
	status: t.Literal("ok"),
	content: t.Nullable(t.String()),
});

export const PageMetadataSchema = t.Record(t.String(), t.String());

export const QualityAnalysisSchema = t.Object({
	score: t.Number(),
	factors: t.Record(t.String(), t.Union([t.Number(), t.Boolean()])),
	issues: t.Array(t.String()),
});

export const ContentAnalysisSchema = t.Object({
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
	quality: t.Optional(QualityAnalysisSchema),
});

export const ExtractedDataSchema = t.Object({
	mainContent: t.Optional(t.String()),
	jsonLd: t.Optional(t.Array(t.Record(t.String(), t.Unknown()))),
	microdata: t.Optional(t.Record(t.String(), t.Unknown())),
	openGraph: t.Optional(t.Record(t.String(), t.String())),
	twitterCards: t.Optional(t.Record(t.String(), t.String())),
	schema: t.Optional(t.Record(t.String(), t.Unknown())),
});

export const MediaInfoSchema = t.Object({
	type: t.Union(MediaTypeValues.map((type) => t.Literal(type))),
	url: t.String(),
	alt: t.Optional(t.String()),
	title: t.Optional(t.String()),
	width: t.Optional(t.String()),
	height: t.Optional(t.String()),
	poster: t.Optional(t.String()),
});

export const ProcessingErrorSchema = t.Object({
	type: t.String(),
	message: t.String(),
	timestamp: t.Optional(t.String()),
});

export const ProcessedPageDataSchema = t.Object({
	extractedData: ExtractedDataSchema,
	metadata: PageMetadataSchema,
	analysis: ContentAnalysisSchema,
	media: t.Array(MediaInfoSchema),
	errors: t.Optional(t.Array(ProcessingErrorSchema)),
	qualityScore: t.Number(),
	language: t.String(),
});

export const QueueStatsSchema = t.Object({
	activeRequests: t.Number({ minimum: 0 }),
	queueLength: t.Number({ minimum: 0 }),
	elapsedTime: t.Number({ minimum: 0 }),
	pagesPerSecond: t.Number({ minimum: 0 }),
});

export const CrawlPagePayloadSchema = t.Object({
	id: t.Nullable(t.Number({ multipleOf: 1 })),
	url: t.String(),
	content: t.Optional(t.String()),
	title: t.Optional(t.String()),
	description: t.Optional(t.String()),
	contentType: t.Optional(t.String()),
	domain: t.Optional(t.String()),
	processedData: t.Optional(ProcessedPageDataSchema),
});

export const CrawlStartedPayloadSchema = t.Object({
	target: t.String(),
	resume: t.Boolean(),
});

export const CrawlProgressPayloadSchema = t.Object({
	counters: CrawlCountersSchema,
	queue: QueueStatsSchema,
	elapsedSeconds: t.Number({ minimum: 0 }),
	pagesPerSecond: t.Number({ minimum: 0 }),
	stopReason: t.Nullable(t.String()),
});

export const CrawlLogPayloadSchema = t.Object({
	message: t.String(),
});

export const CrawlCompletedPayloadSchema = t.Object({
	counters: CrawlCountersSchema,
});

export const CrawlFailedPayloadSchema = t.Object({
	error: t.String(),
	counters: CrawlCountersSchema,
});

export const CrawlStoppedPayloadSchema = t.Object({
	stopReason: t.String(),
	counters: CrawlCountersSchema,
});

export const CrawlPausedPayloadSchema = t.Object({
	stopReason: t.Nullable(t.String()),
	counters: CrawlCountersSchema,
});

export const CrawlEventTypeSchema = t.Union(
	CrawlEventTypeValues.map((value) => t.Literal(value)),
);

const EventEnvelopeBaseSchema = {
	crawlId: t.String(),
	sequence: t.Number({ minimum: 1, multipleOf: 1 }),
	timestamp: t.String({ format: "date-time" }),
};

export const CrawlEventEnvelopeSchema = t.Union([
	t.Object({
		type: t.Literal("crawl.started"),
		...EventEnvelopeBaseSchema,
		payload: CrawlStartedPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.progress"),
		...EventEnvelopeBaseSchema,
		payload: CrawlProgressPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.page"),
		...EventEnvelopeBaseSchema,
		payload: CrawlPagePayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.log"),
		...EventEnvelopeBaseSchema,
		payload: CrawlLogPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.completed"),
		...EventEnvelopeBaseSchema,
		payload: CrawlCompletedPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.failed"),
		...EventEnvelopeBaseSchema,
		payload: CrawlFailedPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.stopped"),
		...EventEnvelopeBaseSchema,
		payload: CrawlStoppedPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.paused"),
		...EventEnvelopeBaseSchema,
		payload: CrawlPausedPayloadSchema,
	}),
]);

export {
	LIVE_CRAWL_EVENT_TYPE_VALUES,
	SETTLED_CRAWL_EVENT_TYPE_VALUES,
	TERMINAL_CRAWL_EVENT_TYPE_VALUES,
};
