import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	type CrawlOptions,
	type CrawlPageData,
	PAGE_TEXT_LIMITS,
} from "../../../../shared/contracts/index.js";
import { utf8ByteLength } from "../../../../shared/text.js";
import type { CompletedPageData } from "../../../storage/repos/crawlItemPersistence.js";
import type { ProcessedContent } from "../../../types.js";
import type { QueueItem } from "../CrawlQueue.js";
import type { FetchResult } from "../FetchService.js";
import { buildPageResult } from "../PageResultBuilder.js";

const options: CrawlOptions = {
	target: "https://example.com/",
	crawlMethod: "full",
	crawlDepth: 1,
	crawlDelay: 0,
	maxPages: 10,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 1,
	retryLimit: 0,
	dynamic: false,
	respectRobots: false,
	contentOnly: false,
	saveMedia: true,
};

const item: QueueItem = {
	url: "https://example.com/post",
	domain: "example.com",
	depth: 0,
	retries: 0,
};

const fetchResult: Extract<FetchResult, { type: "success" }> = {
	type: "success",
	content: "<main>Body</main>",
	effectiveUrl: item.url,
	statusCode: 200,
	contentType: "text/html",
	contentLength: 4096,
	title: "",
	description: "",
	xRobotsTag: null,
};

function processed(overrides: Partial<ProcessedContent> = {}): ProcessedContent {
	return {
		extractedData: { mainContent: "Processed body" },
		metadata: { title: "Metadata title", description: "Metadata description" },
		analysis: { wordCount: 2, readingTime: 1, language: "en" },
		mediaCount: 1,
		links: [],
		errors: [],
		...overrides,
	};
}

describe("page result projection", () => {
	test.each([
		[{ contentOnly: true }, null, 1],
		[{ saveMedia: false }, "<main>Body</main>", 0],
	] as const)("applies storage options %o", (override, expectedContent, expectedMedia) => {
		const result = buildPageResult({ ...options, ...override }, item, fetchResult, processed());
		expect(result.pageData.content).toBe(expectedContent);
		expect(result.pageData.mediaCount).toBe(expectedMedia);
	});

	test("publishes the bounded consumer-backed page projection", () => {
		const result = buildPageResult(
			options,
			item,
			{ ...fetchResult, title: "Fetched title" },
			processed({
				analysis: { wordCount: 2, readingTime: 1, language: "x".repeat(100) },
			}),
		);

		expect(result.eventPayload).toMatchObject({
			url: item.url,
			title: "Fetched title",
			description: "Metadata description",
			details: { wordCount: 2, readingTime: 1 },
		});
		expect(utf8ByteLength(result.eventPayload.details.language ?? "")).toBeLessThanOrEqual(
			PAGE_TEXT_LIMITS.languageBytes,
		);
		expectTypeOf(result.eventPayload).toEqualTypeOf<CrawlPageData>();
		expectTypeOf(result.pageData).toEqualTypeOf<CompletedPageData>();
		expect(result.eventPayload).not.toHaveProperty("id");
		expect(result.pageData).not.toHaveProperty("crawlId");
	});

	test("preserves page-level nofollow for link admission", () => {
		const result = buildPageResult(
			options,
			item,
			fetchResult,
			processed({
				metadata: { robots: "nofollow" },
				links: [{ url: "https://example.com/blocked", nofollow: false }],
			}),
		);

		expect(result.robotsDirectives.nofollow).toBe(true);
		expect(result.pageData.discoveredLinkCount).toBe(1);
	});
});
