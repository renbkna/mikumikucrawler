import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import type { CrawlListResponse, CrawlOptions, CrawlSummary } from "./crawl.js";
import type { CrawlEventEnvelope } from "./events.js";
import type { PageContentResponse } from "./page.js";
import type { CrawledPage, ProcessedPageData, QueueStats } from "./pageData.js";
import {
	CrawlEventEnvelopeSchema,
	CrawlListResponseSchema,
	CrawlOptionsSchema,
	CrawlPagePayloadSchema,
	CrawlSummarySchema,
	PageContentResponseSchema,
	ProcessedPageDataSchema,
	QueueStatsSchema,
} from "./schemas.js";

function check(schema: unknown, value: unknown): boolean {
	return Value.Check(schema as TSchema, value);
}

export function isCrawlOptions(value: unknown): value is CrawlOptions {
	return check(CrawlOptionsSchema, value);
}

export function isCrawlSummary(value: unknown): value is CrawlSummary {
	return check(CrawlSummarySchema, value);
}

export function isCrawlListResponse(
	value: unknown,
): value is CrawlListResponse {
	return check(CrawlListResponseSchema, value);
}

export function isPageContentResponse(
	value: unknown,
): value is PageContentResponse {
	return check(PageContentResponseSchema, value);
}

export function isProcessedPageData(
	value: unknown,
): value is ProcessedPageData {
	return check(ProcessedPageDataSchema, value);
}

export function isCrawledPage(value: unknown): value is CrawledPage {
	return check(CrawlPagePayloadSchema, value);
}

export function isQueueStats(value: unknown): value is QueueStats {
	return check(QueueStatsSchema, value);
}

export function isCrawlEventEnvelope(
	value: unknown,
): value is CrawlEventEnvelope {
	return check(CrawlEventEnvelopeSchema, value);
}

export function parseCrawlEventEnvelope(
	raw: string,
): CrawlEventEnvelope | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	return isCrawlEventEnvelope(parsed) ? parsed : null;
}
