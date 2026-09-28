import { t } from "elysia";
import { CRAWL_METHODS, CRAWL_OPTION_BOUNDS } from "../crawl.js";
import { MAX_URL_LENGTH } from "../url.js";
import { CRAWL_EXPORT_FORMAT_VALUES } from "./api.js";
import { CrawlStatusValues, RESUMABLE_CRAWL_STATUS_VALUES, StopCrawlModeValues } from "./crawl.js";
import { CRAWL_EVENT_TYPES } from "./events.js";
import {
	CRAWL_PAGE_SNAPSHOT_LIMIT,
	maxUtf16LengthForCodePoints,
	PAGE_TEXT_LIMITS,
} from "./pageData.js";

const boundedInteger = (bounds: { min: number; max: number }) =>
	t.Number({ minimum: bounds.min, maximum: bounds.max, multipleOf: 1 });
const nonNegativeInteger = () => t.Number({ minimum: 0, multipleOf: 1 });

export const CrawlStatusSchema = t.Enum(CrawlStatusValues);

export const CrawlMethodValues = CRAWL_METHODS;
export const CrawlMethodSchema = t.Enum(CrawlMethodValues);

export const StopCrawlModeSchema = t.Enum(StopCrawlModeValues);

export const CrawlOptionsSchema = t.Object({
	target: t.String({ minLength: 1, maxLength: MAX_URL_LENGTH }),
	crawlMethod: CrawlMethodSchema,
	crawlDepth: boundedInteger(CRAWL_OPTION_BOUNDS.crawlDepth),
	crawlDelay: boundedInteger(CRAWL_OPTION_BOUNDS.crawlDelay),
	maxPages: boundedInteger(CRAWL_OPTION_BOUNDS.maxPages),
	maxPagesPerDomain: boundedInteger(CRAWL_OPTION_BOUNDS.maxPagesPerDomain),
	maxConcurrentRequests: boundedInteger(CRAWL_OPTION_BOUNDS.maxConcurrentRequests),
	retryLimit: boundedInteger(CRAWL_OPTION_BOUNDS.retryLimit),
	dynamic: t.Boolean(),
	respectRobots: t.Boolean(),
	contentOnly: t.Boolean(),
	saveMedia: t.Boolean(),
});

export const CrawlCountersSchema = t.Object({
	pagesScanned: nonNegativeInteger(),
	successCount: nonNegativeInteger(),
	failureCount: nonNegativeInteger(),
	skippedCount: nonNegativeInteger(),
	linksFound: nonNegativeInteger(),
	mediaFiles: nonNegativeInteger(),
	totalDataKb: t.Number({ minimum: 0 }),
});

export const CrawlSummarySchema = t.Object({
	id: t.String(),
	eventSequence: t.Integer({ minimum: 0 }),
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

export const CrawlListResponseSchema = t.Object({
	crawls: t.Array(CrawlSummarySchema),
});

export const ResumableCrawlSummarySchema = t.Object({
	...CrawlSummarySchema.properties,
	status: t.Enum(RESUMABLE_CRAWL_STATUS_VALUES),
	resumable: t.Literal(true),
});

export const ResumableCrawlListResponseSchema = t.Object({
	crawls: t.Array(ResumableCrawlSummarySchema),
});

export const CreateCrawlResponseSchema = CrawlSummarySchema;
export const StopCrawlResponseSchema = CrawlSummarySchema;
export const GetCrawlResponseSchema = CrawlSummarySchema;

export const ClientCrawlIdSchema = t.String({
	minLength: 36,
	maxLength: 36,
	pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

export const CreateCrawlBodySchema = t.Object({
	id: ClientCrawlIdSchema,
	options: CrawlOptionsSchema,
});

export const StopCrawlBodySchema = t.Optional(
	t.Object({
		mode: t.Optional(StopCrawlModeSchema),
	}),
);

export const CrawlIdParamsSchema = t.Object({
	id: t.String(),
});

export const ExportQuerySchema = t.Object({
	format: t.Optional(t.Union(CRAWL_EXPORT_FORMAT_VALUES.map((value) => t.Literal(value)))),
});

export const PageContentResponseSchema = t.Object({
	status: t.Literal("ok"),
	content: t.Nullable(t.String()),
});

export const PageMetadataSchema = t.Object({
	title: t.Optional(t.String({ maxLength: PAGE_TEXT_LIMITS.metadataValueBytes })),
	description: t.Optional(t.String({ maxLength: PAGE_TEXT_LIMITS.metadataValueBytes })),
	robots: t.Optional(t.String({ maxLength: PAGE_TEXT_LIMITS.metadataValueBytes })),
});

export const CrawlPageDetailsSchema = t.Object({
	wordCount: t.Optional(t.Number({ minimum: 0 })),
	readingTime: t.Optional(t.Number({ minimum: 0 })),
	language: t.Optional(t.String({ maxLength: PAGE_TEXT_LIMITS.languageBytes })),
});

export const QueueStatsSchema = t.Object({
	activeRequests: nonNegativeInteger(),
	queueLength: nonNegativeInteger(),
	elapsedTime: t.Number({ minimum: 0 }),
	pagesPerSecond: t.Number({ minimum: 0 }),
});

export const CrawlPageDataSchema = t.Object(
	{
		url: t.String(),
		title: t.Optional(t.String({ maxLength: PAGE_TEXT_LIMITS.metadataValueBytes })),
		description: t.Optional(t.String({ maxLength: PAGE_TEXT_LIMITS.metadataValueBytes })),
		contentType: t.Optional(t.String()),
		domain: t.Optional(t.String()),
		details: CrawlPageDetailsSchema,
	},
	{ additionalProperties: false },
);

export const StoredPageIdSchema = t.Number({ minimum: 1, multipleOf: 1 });

export const CrawlPagePayloadSchema = t.Object(
	{
		id: StoredPageIdSchema,
		...CrawlPageDataSchema.properties,
	},
	{ additionalProperties: false },
);

export const CrawlPageEventPayloadSchema = t.Object(
	{
		...CrawlPagePayloadSchema.properties,
		pageCount: t.Number({ minimum: 1, multipleOf: 1 }),
	},
	{ additionalProperties: false },
);

export const CrawlPageSummarySchema = t.Object({
	id: StoredPageIdSchema,
	url: t.String(),
	title: t.Optional(
		t.String({ maxLength: maxUtf16LengthForCodePoints(PAGE_TEXT_LIMITS.summaryTextCharacters) }),
	),
	description: t.Optional(
		t.String({ maxLength: maxUtf16LengthForCodePoints(PAGE_TEXT_LIMITS.summaryTextCharacters) }),
	),
	contentType: t.Optional(t.String()),
	domain: t.String(),
	details: CrawlPageDetailsSchema,
});

export const CrawlPagesResponseSchema = t.Object({
	pages: t.Array(CrawlPageSummarySchema, { maxItems: CRAWL_PAGE_SNAPSHOT_LIMIT }),
	count: nonNegativeInteger(),
});

export const CrawlRecoverySnapshotSchema = t.Object({
	crawl: CrawlSummarySchema,
	pages: t.Array(CrawlPageSummarySchema, { maxItems: CRAWL_PAGE_SNAPSHOT_LIMIT }),
	pageCount: nonNegativeInteger(),
});

export const CrawlStartedPayloadSchema = t.Object({
	target: t.String(),
	resume: t.Boolean(),
	/** Whether the run renders JavaScript: false when not requested or when the renderer failed to start. */
	dynamicRendering: t.Boolean(),
});

export const CrawlProgressPayloadSchema = t.Object({
	counters: CrawlCountersSchema,
	queue: QueueStatsSchema,
	stopReason: t.Nullable(t.String()),
});

export const CrawlLogPayloadSchema = t.Object({
	message: t.String(),
	level: t.Union([t.Literal("info"), t.Literal("error"), t.Literal("warn"), t.Literal("success")]),
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

const EventEnvelopeBaseSchema = {
	crawlId: t.String(),
	sequence: t.Number({ minimum: 1, multipleOf: 1 }),
	timestamp: t.String({ format: "date-time" }),
};

export const CrawlEventEnvelopeSchema = t.Union([
	t.Object({
		type: t.Literal(CRAWL_EVENT_TYPES.started),
		...EventEnvelopeBaseSchema,
		payload: CrawlStartedPayloadSchema,
	}),
	t.Object({
		type: t.Literal(CRAWL_EVENT_TYPES.progress),
		...EventEnvelopeBaseSchema,
		payload: CrawlProgressPayloadSchema,
	}),
	t.Object({
		type: t.Literal(CRAWL_EVENT_TYPES.page),
		...EventEnvelopeBaseSchema,
		payload: CrawlPageEventPayloadSchema,
	}),
	t.Object({
		type: t.Literal(CRAWL_EVENT_TYPES.log),
		...EventEnvelopeBaseSchema,
		payload: CrawlLogPayloadSchema,
	}),
	t.Object({
		type: t.Literal(CRAWL_EVENT_TYPES.completed),
		...EventEnvelopeBaseSchema,
		payload: CrawlCompletedPayloadSchema,
	}),
	t.Object({
		type: t.Literal(CRAWL_EVENT_TYPES.failed),
		...EventEnvelopeBaseSchema,
		payload: CrawlFailedPayloadSchema,
	}),
	t.Object({
		type: t.Literal(CRAWL_EVENT_TYPES.stopped),
		...EventEnvelopeBaseSchema,
		payload: CrawlStoppedPayloadSchema,
	}),
	t.Object({
		type: t.Literal(CRAWL_EVENT_TYPES.paused),
		...EventEnvelopeBaseSchema,
		payload: CrawlPausedPayloadSchema,
	}),
]);
