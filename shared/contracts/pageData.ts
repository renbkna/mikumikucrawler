import type { Static } from "typebox";
import type {
	ContentAnalysisSchema,
	CrawlPageDataSchema,
	CrawlPageDetailsSchema,
	CrawlPagePayloadSchema,
	CrawlPageSummarySchema,
	CrawlPagesResponseSchema,
	ExtractedDataSchema,
	PageContentResponseSchema,
	PageMetadataSchema,
	QueueStatsSchema,
} from "./schemas.js";

export const CRAWL_PAGE_SNAPSHOT_LIMIT = 200;
export const PAGE_TEXT_LIMITS = {
	metadataValueBytes: 2048,
	languageBytes: 64,
	summaryTextCharacters: 512,
	searchSnippetCharacters: 512,
} as const;

/** TypeBox measures strings in UTF-16 units; SQLite projections count Unicode code points. */
export const maxUtf16LengthForCodePoints = (limit: number): number => limit * 2;

export type ContentAnalysis = Static<typeof ContentAnalysisSchema>;
export type ExtractedData = Static<typeof ExtractedDataSchema>;
export type PageContentResponse = Static<typeof PageContentResponseSchema>;
export type PageMetadata = Static<typeof PageMetadataSchema>;
export type QueueStats = Static<typeof QueueStatsSchema>;
export type CrawlPageData = Static<typeof CrawlPageDataSchema>;
export type CrawlPageDetails = Static<typeof CrawlPageDetailsSchema>;
export type CrawledPage = Static<typeof CrawlPagePayloadSchema>;
export type CrawlPageSummary = Static<typeof CrawlPageSummarySchema>;
export type CrawlPagesResponse = Static<typeof CrawlPagesResponseSchema>;
