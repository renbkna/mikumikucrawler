import { t } from "elysia";
import { CRAWL_EXPORT_FORMAT_VALUES } from "../../shared/contracts/api.js";
import { CRAWL_METHODS, CRAWL_OPTION_BOUNDS } from "../../shared/crawl.js";
import {
	DEFAULT_CRAWL_LIST_LIMIT,
	CrawlStatusValues,
	StopCrawlModeValues,
} from "../../shared/contracts/crawl.js";
import { OkResponseSchema, optionalBoundedListLimitSchema } from "./http.js";

// Re-export shared types for server consumers
export { CrawlStatusValues } from "../../shared/contracts/crawl.js";
export type {
	CrawlCounters,
	CrawlListResponse,
	CrawlStatus,
	CrawlSummary,
	ResumableSessionSummary,
	StopCrawlMode,
} from "../../shared/contracts/crawl.js";

export const CrawlStatusSchema = t.UnionEnum([...CrawlStatusValues]);

export const CrawlMethodValues = CRAWL_METHODS;
export type CrawlMethod = (typeof CrawlMethodValues)[number];

export const CrawlMethodSchema = t.UnionEnum([...CrawlMethodValues]);

export const StopCrawlModeSchema = t.UnionEnum([...StopCrawlModeValues]);

export const StopCrawlBodySchema = t.Optional(
	t.Object({
		mode: t.Optional(StopCrawlModeSchema),
	}),
);

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
export const DeleteCrawlResponseSchema = OkResponseSchema;

export const CreateCrawlBodySchema = CrawlOptionsSchema;

export const CrawlIdParamsSchema = t.Object({
	id: t.String(),
});

export const ExportQuerySchema = t.Object({
	format: t.Optional(
		t.Union(CRAWL_EXPORT_FORMAT_VALUES.map((value) => t.Literal(value))),
	),
});
