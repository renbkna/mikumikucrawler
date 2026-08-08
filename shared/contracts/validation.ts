import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { CrawlMethod } from "../crawl.js";
import type {
	CrawlCounters,
	CrawlOptions,
	CrawlRecoverySnapshot,
	CrawlSummary,
	ResumableCrawlListResponse,
} from "./crawl.js";
import type { CrawlEventEnvelope } from "./events.js";
import { type DeleteCrawlResponse, DeleteCrawlResponseSchema } from "./http.js";
import type {
	CrawlPageData,
	CrawlPageDetails,
	CrawlPageSummary,
	PageContentResponse,
} from "./pageData.js";
import {
	CrawlCountersSchema,
	CrawlEventEnvelopeSchema,
	CrawlOptionsSchema,
	CrawlPageDataSchema,
	CrawlPageDetailsSchema,
	CrawlPageSummarySchema,
	CrawlRecoverySnapshotSchema,
	CrawlSummarySchema,
	PageContentResponseSchema,
	ResumableCrawlListResponseSchema,
} from "./schemas.js";
import { type SearchResponse, SearchResponseSchema } from "./search.js";

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

	return (
		isCrawlOptions(value.options) &&
		isCrawlCounters(value.counters) &&
		value.target === value.options.target
	);
}

export function isResumableCrawlListResponse(value: unknown): value is ResumableCrawlListResponse {
	return check(ResumableCrawlListResponseSchema, value) && value.crawls.every(isCrawlSummary);
}

export function isDeleteCrawlResponse(value: unknown): value is DeleteCrawlResponse {
	return check(DeleteCrawlResponseSchema, value);
}

export function isPageContentResponse(value: unknown): value is PageContentResponse {
	return check(PageContentResponseSchema, value);
}

export function isCrawlPageData(value: unknown): value is CrawlPageData {
	return check(CrawlPageDataSchema, value);
}

export function isCrawlPageDetails(value: unknown): value is CrawlPageDetails {
	return check(CrawlPageDetailsSchema, value);
}

export function isCrawlPageSummary(value: unknown): value is CrawlPageSummary {
	return check(CrawlPageSummarySchema, value);
}

export function isCrawlRecoverySnapshot(value: unknown): value is CrawlRecoverySnapshot {
	return (
		check(CrawlRecoverySnapshotSchema, value) &&
		isCrawlSummary(value.crawl) &&
		value.pages.every(isCrawlPageSummary) &&
		value.pageCount >= value.pages.length
	);
}

export function isSearchResponse(value: unknown): value is SearchResponse {
	return check(SearchResponseSchema, value) && value.count >= value.results.length;
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
