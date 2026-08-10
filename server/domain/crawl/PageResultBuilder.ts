import {
	type CrawlOptions,
	type CrawlPageData,
	isCrawlPageData,
	PAGE_TEXT_LIMITS,
} from "../../../shared/contracts/index.js";
import { truncateUtf8Text } from "../../../shared/text.js";
import type { CompletedPageData } from "../../storage/repos/crawlItemPersistence.js";
import type { ProcessedContent } from "../../types.js";
import type { QueueItem } from "./CrawlQueue.js";
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
	const mediaCount =
		options.saveMedia && (options.crawlMethod === "media" || options.crawlMethod === "full")
			? processedContent.mediaCount
			: 0;
	const mainContent = processedContent.extractedData.mainContent ?? "";
	const language = processedContent.analysis.language
		? truncateUtf8Text(processedContent.analysis.language, PAGE_TEXT_LIMITS.languageBytes)
		: undefined;
	const details = {
		...(processedContent.analysis.wordCount === undefined
			? {}
			: { wordCount: processedContent.analysis.wordCount }),
		...(processedContent.analysis.readingTime === undefined
			? {}
			: { readingTime: processedContent.analysis.readingTime }),
		...(language === undefined ? {} : { language }),
	};

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
			mainContent,
			wordCount: processedContent.analysis.wordCount ?? 0,
			readingTime: processedContent.analysis.readingTime ?? 0,
			language: language ?? "unknown",
			mediaCount,
			discoveredLinkCount: processedContent.links.length,
		},
		eventPayload,
	};
}
