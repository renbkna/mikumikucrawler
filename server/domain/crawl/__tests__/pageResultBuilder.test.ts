import { describe, expect, test } from "bun:test";
import type { CrawlOptions } from "../../../../shared/contracts/index.js";
import type { ProcessedContent } from "../../../types.js";
import { PageResultBuilder } from "../PageResultBuilder.js";
import type { QueueItem } from "../CrawlQueue.js";
import type { FetchResult } from "../FetchService.js";

const baseOptions: CrawlOptions = {
	target: "https://example.com",
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
	content: "<html><main>Body</main></html>",
	statusCode: 200,
	contentType: "text/html",
	contentLength: 4096,
	title: "",
	description: "",
	lastModified: null,
	etag: null,
	xRobotsTag: null,
	isDynamic: false,
};

function createProcessedContent(): ProcessedContent {
	return {
		extractedData: {
			mainContent: "Processed body",
			jsonLd: [{ "@type": "Article" }],
		},
		metadata: {
			title: "Metadata title",
			description: "Metadata description",
			robots: "index,follow",
		},
		analysis: {
			language: "en",
			quality: {
				score: 91,
				factors: {},
				issues: [],
			},
		},
		media: [
			{
				type: "image",
				url: "https://example.com/image.png",
				alt: "cover",
			},
		],
		links: [],
		errors: [],
	};
}

describe("page result builder contract", () => {
	test("contentOnly=true stores null content", () => {
		const builder = new PageResultBuilder("crawl-1", {
			...baseOptions,
			contentOnly: true,
		});

		const result = builder.build(
			item,
			fetchResult,
			createProcessedContent(),
			[],
		);

		expect(result.saveInput.content).toBeNull();
	});

	test("saveMedia=false strips media from save and event payload and reports zero media", () => {
		const builder = new PageResultBuilder("crawl-1", {
			...baseOptions,
			saveMedia: false,
		});

		const result = builder.build(
			item,
			fetchResult,
			createProcessedContent(),
			[],
		);

		expect(result.saveInput.processedContent.media).toEqual([]);
		expect(result.eventPayload.processedData?.media).toEqual([]);
		expect(result.mediaCount).toBe(0);
	});

	test("saveMedia=true with media or full crawl retains media", () => {
		const builder = new PageResultBuilder("crawl-1", {
			...baseOptions,
			crawlMethod: "media",
			saveMedia: true,
		});

		const result = builder.build(
			item,
			fetchResult,
			createProcessedContent(),
			[],
		);

		expect(result.saveInput.processedContent.media).toHaveLength(1);
		expect(result.eventPayload.processedData?.media).toHaveLength(1);
		expect(result.mediaCount).toBe(1);
	});

	test("fetch title and description override processed metadata fallback", () => {
		const builder = new PageResultBuilder("crawl-1", baseOptions);
		const result = builder.build(
			item,
			{
				...fetchResult,
				title: "Fetched title",
				description: "Fetched description",
			},
			createProcessedContent(),
			[],
		);

		expect(result.resolvedTitle).toBe("Fetched title");
		expect(result.resolvedDescription).toBe("Fetched description");
		expect(result.saveInput.title).toBe("Fetched title");
		expect(result.eventPayload.title).toBe("Fetched title");
	});

	test("pending event payload contains public page fields except id", () => {
		const builder = new PageResultBuilder("crawl-1", baseOptions);

		const result = builder.build(
			item,
			fetchResult,
			createProcessedContent(),
			[],
		);

		expect(result.eventPayload).toEqual({
			url: "https://example.com/post",
			title: "Metadata title",
			description: "Metadata description",
			contentType: "text/html",
			domain: "example.com",
			processedData: {
				extractedData: {
					mainContent: "Processed body",
					jsonLd: [{ "@type": "Article" }],
				},
				metadata: {
					title: "Metadata title",
					description: "Metadata description",
					robots: "index,follow",
				},
				analysis: {
					language: "en",
					quality: {
						score: 91,
						factors: {},
						issues: [],
					},
				},
				media: [
					{
						type: "image",
						url: "https://example.com/image.png",
						alt: "cover",
					},
				],
				errors: [],
				qualityScore: 91,
				language: "en",
			},
		});
		expect(result.eventPayload).not.toHaveProperty("id");
	});

	test("page-level nofollow strips replayable stored links", () => {
		const builder = new PageResultBuilder("crawl-1", baseOptions);
		const result = builder.build(
			item,
			fetchResult,
			{
				...createProcessedContent(),
				metadata: {
					robots: "nofollow",
				},
			},
			[
				{
					url: "https://example.com/blocked",
					nofollow: false,
				},
			],
		);

		expect(result.robotsDirectives.nofollow).toBe(true);
		expect(result.saveInput.links).toEqual([]);
	});
});
