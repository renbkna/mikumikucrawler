import {
	type CrawlOptions,
	type CrawlPageData,
	isCrawlPageData,
	PAGE_TEXT_LIMITS,
} from "../../../shared/contracts/index.js";
import { truncateUtf8Text } from "../../../shared/text.js";
import type { ProcessedContent } from "../../types.js";
import type { QueueItem } from "./CrawlQueue.js";
import type { CompletedPageData } from "./completion.js";
import type { FetchResult } from "./FetchService.js";
import { mergeRobotsDirectives } from "./PageDecisionPolicy.js";

type SuccessfulFetchResult = Extract<FetchResult, { type: "success" }>;

export interface BuiltPageResult {
	robotsDirectives: ReturnType<typeof mergeRobotsDirectives>;
	pageData: CompletedPageData;
	eventPayload: CrawlPageData;
}

export function buildPageResult(
	options: CrawlOptions,
	item: QueueItem,
	fetchResult: SuccessfulFetchResult,
	processedContent: ProcessedContent,
): BuiltPageResult {
	const resolvedTitle = truncateUtf8Text(
		fetchResult.title || processedContent.metadata.title || "",
		PAGE_TEXT_LIMITS.metadataValueBytes,
	);
	const resolvedDescription = truncateUtf8Text(
		fetchResult.description || processedContent.metadata.description || "",
		PAGE_TEXT_LIMITS.metadataValueBytes,
	);
	const robotsDirectives = mergeRobotsDirectives(
		processedContent.metadata.robots,
		fetchResult.xRobotsTag,
	);
	// Valid crawl options only enable saveMedia for crawl methods that count media.
	const mediaCount = options.saveMedia ? processedContent.mediaCount : 0;
	const { wordCount, readingTime } = processedContent.analysis;
	const language = truncateUtf8Text(
		processedContent.analysis.language,
		PAGE_TEXT_LIMITS.languageBytes,
	);
	const details = { wordCount, readingTime, language };

	const eventPayload: CrawlPageData = {
		url: item.url,
		title: resolvedTitle,
		description: resolvedDescription,
		contentType: fetchResult.contentType,
		domain: item.domain,
		details,
	};
	if (!isCrawlPageData(eventPayload)) {
		throw new Error("Page event projection violates the shared crawl-page contract");
	}

	return {
		robotsDirectives,
		pageData: {
			contentType: fetchResult.contentType,
			contentLength: fetchResult.contentLength,
			title: resolvedTitle,
			description: resolvedDescription,
			content:
				options.contentOnly || typeof fetchResult.content !== "string" ? null : fetchResult.content,
			mainContent: processedContent.mainContent,
			wordCount,
			readingTime,
			language,
			mediaCount,
			discoveredLinkCount: processedContent.links.length,
		},
		eventPayload,
	};
}
