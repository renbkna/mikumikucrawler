import { describe, expect, test } from "bun:test";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CrawlCounters, CrawlOptions, CrawlSummary } from "../../../shared/contracts/index.js";
import {
	isCrawlCounters,
	isCrawlEventEnvelope,
	isCrawlListResponse,
	isCrawlOptions,
	isCrawlSummary,
	normalizeCrawlOptions,
} from "../../../shared/contracts/index.js";
import { CrawlCountersSchema, QueueStatsSchema } from "../../../shared/contracts/schemas.js";

const OPTIONS: CrawlOptions = {
	target: "https://example.com",
	crawlMethod: "full",
	crawlDepth: 2,
	crawlDelay: 250,
	maxPages: 20,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 2,
	retryLimit: 1,
	dynamic: false,
	respectRobots: true,
	contentOnly: false,
	saveMedia: true,
};

const COUNTERS: CrawlCounters = {
	pagesScanned: 3,
	successCount: 1,
	failureCount: 1,
	skippedCount: 1,
	linksFound: 4,
	mediaFiles: 2,
	totalDataKb: 5,
};

const SUMMARY: CrawlSummary = {
	id: "crawl-1",
	target: OPTIONS.target,
	status: "running",
	options: OPTIONS,
	counters: COUNTERS,
	createdAt: "2026-07-13T00:00:00.000Z",
	startedAt: "2026-07-13T00:00:01.000Z",
	updatedAt: "2026-07-13T00:00:02.000Z",
	completedAt: null,
	stopReason: null,
	resumable: false,
};

function check(schema: unknown, value: unknown): boolean {
	return Value.Check(schema as TSchema, value);
}

describe("shared semantic validation", () => {
	test("every counter scalar is a non-negative integer", () => {
		for (const key of Object.keys(COUNTERS) as (keyof CrawlCounters)[]) {
			expect(check(CrawlCountersSchema, { ...COUNTERS, [key]: 1.5 }), key).toBe(false);
			expect(check(CrawlCountersSchema, { ...COUNTERS, [key]: -1 }), key).toBe(false);
			expect(check(CrawlCountersSchema, { ...COUNTERS, [key]: 1 }), key).toBe(true);
		}
	});

	test("queue cardinalities reject fractions without constraining rate metrics", () => {
		const queue = {
			activeRequests: 1,
			queueLength: 2,
			elapsedTime: 1.5,
			pagesPerSecond: 0.25,
		};

		expect(check(QueueStatsSchema, queue)).toBe(true);
		expect(check(QueueStatsSchema, { ...queue, activeRequests: 0.5 })).toBe(false);
		expect(check(QueueStatsSchema, { ...queue, queueLength: 1.5 })).toBe(false);
	});

	test("counter identity is enforced by every browser-facing aggregate parser", () => {
		const invalidCounters = { ...COUNTERS, successCount: 4 };
		const invalidSummary = { ...SUMMARY, counters: invalidCounters };
		const invalidEvent = {
			type: "crawl.completed",
			crawlId: SUMMARY.id,
			sequence: 1,
			timestamp: SUMMARY.updatedAt,
			payload: { counters: invalidCounters },
		};

		expect(isCrawlCounters(COUNTERS)).toBe(true);
		expect(isCrawlCounters(invalidCounters)).toBe(false);
		expect(isCrawlSummary(invalidSummary)).toBe(false);
		expect(isCrawlListResponse({ crawls: [invalidSummary] })).toBe(false);
		expect(isCrawlEventEnvelope(invalidEvent)).toBe(false);
	});

	test("one shared option policy rejects and normalizes links plus saved media", () => {
		const invalid = { ...OPTIONS, crawlMethod: "links", saveMedia: true } as const;

		expect(isCrawlOptions(invalid)).toBe(false);
		expect(normalizeCrawlOptions(invalid)).toEqual({ ...invalid, saveMedia: false });
		expect(isCrawlOptions(normalizeCrawlOptions(invalid))).toBe(true);
		expect(normalizeCrawlOptions(OPTIONS)).toBe(OPTIONS);
	});
});
