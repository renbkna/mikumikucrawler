import { t } from "elysia";
import { CRAWL_METHODS, CRAWL_OPTION_BOUNDS } from "../../shared/crawl.js";

export const CrawlStatusValues = [
	"pending",
	"starting",
	"running",
	"stopping",
	"completed",
	"stopped",
	"failed",
	"interrupted",
] as const;

export type CrawlStatus = (typeof CrawlStatusValues)[number];

export const CrawlStatusSchema = t.UnionEnum([...CrawlStatusValues]);

export const CrawlMethodValues = CRAWL_METHODS;
export type CrawlMethod = (typeof CrawlMethodValues)[number];

export const CrawlMethodSchema = t.UnionEnum([...CrawlMethodValues]);

export const CrawlOptionsSchema = t.Object({
	target: t.String({ minLength: 1 }),
	crawlMethod: CrawlMethodSchema,
	crawlDepth: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.crawlDepth.min,
		maximum: CRAWL_OPTION_BOUNDS.crawlDepth.max,
	}),
	crawlDelay: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.crawlDelay.min,
		maximum: CRAWL_OPTION_BOUNDS.crawlDelay.max,
	}),
	maxPages: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.maxPages.min,
		maximum: CRAWL_OPTION_BOUNDS.maxPages.max,
	}),
	maxPagesPerDomain: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.maxPagesPerDomain.min,
		maximum: CRAWL_OPTION_BOUNDS.maxPagesPerDomain.max,
	}),
	maxConcurrentRequests: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.maxConcurrentRequests.min,
		maximum: CRAWL_OPTION_BOUNDS.maxConcurrentRequests.max,
	}),
	retryLimit: t.Number({
		minimum: CRAWL_OPTION_BOUNDS.retryLimit.min,
		maximum: CRAWL_OPTION_BOUNDS.retryLimit.max,
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

export type CrawlCounters = typeof CrawlCountersSchema.static;

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

export type CrawlSummary = typeof CrawlSummarySchema.static;

export const CrawlListQuerySchema = t.Object({
	status: t.Optional(CrawlStatusSchema),
	from: t.Optional(t.String({ format: "date-time" })),
	to: t.Optional(t.String({ format: "date-time" })),
	limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
});

export const CrawlListResponseSchema = t.Object({
	crawls: t.Array(CrawlSummarySchema),
});

export const CreateCrawlResponseSchema = CrawlSummarySchema;
export const StopCrawlResponseSchema = CrawlSummarySchema;
export const ResumeCrawlResponseSchema = CrawlSummarySchema;
export const GetCrawlResponseSchema = CrawlSummarySchema;

export const CreateCrawlBodySchema = CrawlOptionsSchema;

export const CrawlIdParamsSchema = t.Object({
	id: t.String(),
});

export const ExportQuerySchema = t.Object({
	format: t.Optional(t.Union([t.Literal("json"), t.Literal("csv")])),
});
