import type {
	ContentAnalysisSchema,
	CrawlPageDataSchema,
	CrawlPagePayloadSchema,
	CrawlPageSummarySchema,
	CrawlPagesResponseSchema,
	ExtractedDataSchema,
	MediaInfoSchema,
	PageMetadataSchema,
	ProcessedPageDataSchema,
	ProcessingErrorSchema,
	QualityAnalysisSchema,
	QueueStatsSchema,
} from "./schemas.js";

export const MediaTypeValues = ["image", "video", "audio"] as const;
export const CRAWL_PAGE_SNAPSHOT_LIMIT = 200;

export type MediaInfo = typeof MediaInfoSchema.static;
export type ProcessingError = typeof ProcessingErrorSchema.static;
export type QualityAnalysis = typeof QualityAnalysisSchema.static;
export type ContentAnalysis = typeof ContentAnalysisSchema.static;
export type ExtractedData = typeof ExtractedDataSchema.static;
export type PageMetadata = typeof PageMetadataSchema.static;
export type ProcessedPageData = typeof ProcessedPageDataSchema.static;
export type QueueStats = typeof QueueStatsSchema.static;
export type CrawlPageData = typeof CrawlPageDataSchema.static;
export type CrawledPage = typeof CrawlPagePayloadSchema.static;
export type CrawlPageSummary = typeof CrawlPageSummarySchema.static;
export type CrawlPagesResponse = typeof CrawlPagesResponseSchema.static;
