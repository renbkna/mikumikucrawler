import { Value } from "@sinclair/typebox/value";
import { t } from "elysia";

export const MediaTypeValues = ["image", "video", "audio"] as const;

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

export type MediaInfo = typeof MediaInfoSchema.static;
export type ProcessingError = typeof ProcessingErrorSchema.static;
export type QualityAnalysis = typeof QualityAnalysisSchema.static;
export type ContentAnalysis = typeof ContentAnalysisSchema.static;
export type ExtractedData = typeof ExtractedDataSchema.static;
export type PageMetadata = typeof PageMetadataSchema.static;
export type ProcessedPageData = typeof ProcessedPageDataSchema.static;
export type QueueStats = typeof QueueStatsSchema.static;
export type CrawledPage = typeof CrawlPagePayloadSchema.static;

export function isProcessedPageData(
	value: unknown,
): value is ProcessedPageData {
	return Value.Check(ProcessedPageDataSchema, value);
}

export function isCrawledPage(value: unknown): value is CrawledPage {
	return Value.Check(CrawlPagePayloadSchema, value);
}

export function isQueueStats(value: unknown): value is QueueStats {
	return Value.Check(QueueStatsSchema, value);
}
