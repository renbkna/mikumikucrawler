import { describe, expect, test } from "bun:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { CrawlCounters, CrawlOptions, CrawlSummary } from "../../../shared/contracts/index.js";
import {
	crawlOptionsEqual,
	isCrawlCounters,
	isCrawlEventEnvelope,
	isCrawlOptions,
	isCrawlPageSummary,
	isCrawlSummary,
	isResumableCrawlListResponse,
	isSearchResponse,
	normalizeCrawlOptions,
	PAGE_TEXT_LIMITS,
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
	eventSequence: 3,
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
	test("crawl option identity follows every owned field without depending on key order", () => {
		const reordered = Object.fromEntries(Object.entries(OPTIONS).toReversed()) as CrawlOptions;
		expect(crawlOptionsEqual(OPTIONS, reordered)).toBe(true);

		for (const key of Object.keys(OPTIONS) as Array<keyof CrawlOptions>) {
			const value = OPTIONS[key];
			const changed = {
				...OPTIONS,
				[key]:
					typeof value === "boolean" ? !value : typeof value === "number" ? value + 1 : `${value}#`,
			} as CrawlOptions;
			expect(crawlOptionsEqual(OPTIONS, changed)).toBe(false);
		}

		expect(crawlOptionsEqual(OPTIONS, { ...OPTIONS, futurePolicy: true } as CrawlOptions)).toBe(
			false,
		);
	});

	test("cardinality counters are non-negative integers and data volume preserves fractions", () => {
		const cardinalityKeys = [
			"pagesScanned",
			"successCount",
			"failureCount",
			"skippedCount",
			"linksFound",
			"mediaFiles",
		] as const satisfies readonly (keyof CrawlCounters)[];
		for (const key of cardinalityKeys) {
			expect(check(CrawlCountersSchema, { ...COUNTERS, [key]: 1.5 }), key).toBe(false);
			expect(check(CrawlCountersSchema, { ...COUNTERS, [key]: -1 }), key).toBe(false);
			expect(check(CrawlCountersSchema, { ...COUNTERS, [key]: 1 }), key).toBe(true);
		}
		expect(check(CrawlCountersSchema, { ...COUNTERS, totalDataKb: 1.5 })).toBe(true);
		expect(check(CrawlCountersSchema, { ...COUNTERS, totalDataKb: -1 })).toBe(false);
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
		expect(isCrawlEventEnvelope(invalidEvent)).toBe(false);
	});

	test("summary target identity and resumable-list semantics are enforced together", () => {
		expect(isCrawlSummary({ ...SUMMARY, target: "https://stale.example" })).toBe(false);
		expect(
			isResumableCrawlListResponse({
				crawls: [{ ...SUMMARY, status: "paused", resumable: true }],
			}),
		).toBe(true);
		expect(
			isResumableCrawlListResponse({
				crawls: [{ ...SUMMARY, status: "running", resumable: true }],
			}),
		).toBe(false);
		expect(
			isResumableCrawlListResponse({
				crawls: [{ ...SUMMARY, status: "paused", resumable: false }],
			}),
		).toBe(false);
	});

	test("search responses preserve durable page cardinality and identity constraints", () => {
		const response = {
			crawlId: "crawl-1",
			query: "needle",
			count: 1,
			results: [
				{
					id: 1,
					url: "https://example.com/page",
					title: "Page",
					description: "Description",
					domain: "example.com",
					snippet: "needle",
				},
			],
		};

		expect(isSearchResponse(response)).toBe(true);
		expect(
			isSearchResponse({
				...response,
				results: [{ ...response.results[0], id: 0.5 }],
			}),
		).toBe(false);
		expect(isSearchResponse({ ...response, count: 0 })).toBe(false);
	});

	test("response schemas accept the full SQLite Unicode code-point projection", () => {
		const summaryText = "😀".repeat(PAGE_TEXT_LIMITS.summaryTextCharacters);
		expect(
			isCrawlPageSummary({
				id: 1,
				url: "https://example.com/page",
				domain: "example.com",
				title: summaryText,
				description: summaryText,
				details: {},
			}),
		).toBe(true);
		expect(
			isSearchResponse({
				crawlId: "crawl-1",
				query: "needle",
				count: 1,
				results: [
					{
						id: 1,
						url: "https://example.com/page",
						title: summaryText,
						description: summaryText,
						domain: "example.com",
						snippet: "😀".repeat(PAGE_TEXT_LIMITS.searchSnippetCharacters),
					},
				],
			}),
		).toBe(true);
	});

	test("one shared option policy rejects and normalizes links plus saved media", () => {
		const invalid = { ...OPTIONS, crawlMethod: "links", saveMedia: true } as const;

		expect(isCrawlOptions(invalid)).toBe(false);
		expect(normalizeCrawlOptions(invalid)).toEqual({ ...invalid, saveMedia: false });
		expect(isCrawlOptions(normalizeCrawlOptions(invalid))).toBe(true);
		expect(normalizeCrawlOptions(OPTIONS)).toBe(OPTIONS);
	});
});
