import { t } from "elysia";

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

export const CrawlStatusSchema = t.String();

export const CrawlMethodValues = ["links", "media", "full"] as const;
export type CrawlMethod = (typeof CrawlMethodValues)[number];

export const CrawlMethodSchema = t.String();

export const CrawlOptionsSchema = t.Object({
	target: t.String({ minLength: 1 }),
	crawlMethod: CrawlMethodSchema,
	crawlDepth: t.Number({ minimum: 1, maximum: 5 }),
	crawlDelay: t.Number({ minimum: 200, maximum: 10_000 }),
	maxPages: t.Number({ minimum: 1, maximum: 200 }),
	maxPagesPerDomain: t.Number({ minimum: 0, maximum: 1000 }),
	maxConcurrentRequests: t.Number({ minimum: 1, maximum: 10 }),
	retryLimit: t.Number({ minimum: 0, maximum: 5 }),
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
