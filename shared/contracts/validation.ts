import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CrawlMethod } from "../crawl.js";
import type {
	CrawlCounters,
	CrawlListResponse,
	CrawlOptions,
	CrawlRecoverySnapshot,
	CrawlSummary,
} from "./crawl.js";
import type { CrawlEventEnvelope } from "./events.js";
import type { PageContentResponse } from "./page.js";
import type {
	CrawledPage,
	CrawlPageSummary,
	CrawlPagesResponse,
	ProcessedPageData,
	QueueStats,
} from "./pageData.js";
import {
	CrawlCountersSchema,
	CrawlEventEnvelopeSchema,
	CrawlListResponseSchema,
	CrawlOptionsSchema,
	CrawlPagePayloadSchema,
	CrawlPageSummarySchema,
	CrawlPagesResponseSchema,
	CrawlRecoverySnapshotSchema,
	CrawlSummarySchema,
	PageContentResponseSchema,
	ProcessedPageDataSchema,
	QueueStatsSchema,
} from "./schemas.js";

function check<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
	return Value.Check(schema, value);
}

export function crawlMethodSupportsSavedMedia(crawlMethod: CrawlMethod): boolean {
	return crawlMethod !== "links";
}

export function hasValidCrawlOptionSemantics(options: CrawlOptions): boolean {
	return crawlMethodSupportsSavedMedia(options.crawlMethod) || !options.saveMedia;
}

export function normalizeCrawlOptions(options: CrawlOptions): CrawlOptions {
	if (hasValidCrawlOptionSemantics(options)) {
		return options;
	}

	return { ...options, saveMedia: false };
}

export function isCrawlOptions(value: unknown): value is CrawlOptions {
	return check(CrawlOptionsSchema, value) && hasValidCrawlOptionSemantics(value);
}

export function hasValidCrawlCounterIdentity(counters: CrawlCounters): boolean {
	return (
		counters.pagesScanned === counters.successCount + counters.failureCount + counters.skippedCount
	);
}

export function isCrawlCounters(value: unknown): value is CrawlCounters {
	return check(CrawlCountersSchema, value) && hasValidCrawlCounterIdentity(value);
}

export function isCrawlSummary(value: unknown): value is CrawlSummary {
	if (!check(CrawlSummarySchema, value)) {
		return false;
	}

	return isCrawlOptions(value.options) && isCrawlCounters(value.counters);
}

export function isCrawlListResponse(value: unknown): value is CrawlListResponse {
	return check(CrawlListResponseSchema, value) && value.crawls.every(isCrawlSummary);
}

export function isPageContentResponse(value: unknown): value is PageContentResponse {
	return check(PageContentResponseSchema, value);
}

export function isProcessedPageData(value: unknown): value is ProcessedPageData {
	return check(ProcessedPageDataSchema, value);
}

export function isCrawledPage(value: unknown): value is CrawledPage {
	return check(CrawlPagePayloadSchema, value);
}

export function isCrawlPageSummary(value: unknown): value is CrawlPageSummary {
	return check(CrawlPageSummarySchema, value);
}

export function isCrawlPagesResponse(value: unknown): value is CrawlPagesResponse {
	return (
		check(CrawlPagesResponseSchema, value) &&
		value.pages.every(isCrawlPageSummary) &&
		value.count >= value.pages.length
	);
}

export function isCrawlRecoverySnapshot(value: unknown): value is CrawlRecoverySnapshot {
	return (
		check(CrawlRecoverySnapshotSchema, value) &&
		isCrawlSummary(value.crawl) &&
		value.pages.every(isCrawlPageSummary) &&
		value.pageCount >= value.pages.length
	);
}

export function isQueueStats(value: unknown): value is QueueStats {
	return check(QueueStatsSchema, value);
}

export function isCrawlEventEnvelope(value: unknown): value is CrawlEventEnvelope {
	if (!check(CrawlEventEnvelopeSchema, value)) {
		return false;
	}

	return !("counters" in value.payload) || isCrawlCounters(value.payload.counters);
}

export function parseCrawlEventEnvelope(raw: string): CrawlEventEnvelope | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	return isCrawlEventEnvelope(parsed) ? parsed : null;
}
