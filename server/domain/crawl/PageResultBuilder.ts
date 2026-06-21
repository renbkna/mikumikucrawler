import type { CrawlOptions, CrawlPagePayload } from "../../../shared/contracts/index.js";
import type { SavePageInput } from "../../storage/repos/pageRepo.js";
import type { ProcessedContent } from "../../types.js";
import type { QueueItem } from "./CrawlQueue.js";
import type { FetchResult } from "./FetchService.js";
import { mergeRobotsDirectives } from "./PageDecisionPolicy.js";

export type PendingCrawlPagePayload = Omit<CrawlPagePayload, "id">;

type SuccessfulFetchResult = Extract<FetchResult, { type: "success" }>;

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export interface BuiltPageResult {
	resolvedTitle: string;
	resolvedDescription: string;
	mainContent: string;
	robotsDirectives: ReturnType<typeof mergeRobotsDirectives>;
	retainedMedia: ProcessedContent["media"];
	mediaCount: number;
	dataSizeKb: number;
	saveInput: SavePageInput;
	eventPayload: PendingCrawlPagePayload;
}

export function buildPageResult(
	crawlId: string,
	options: CrawlOptions,
	item: QueueItem,
	fetchResult: SuccessfulFetchResult,
	processedContent: ProcessedContent,
	crawlLinks: SavePageInput["links"],
): BuiltPageResult {
	const resolvedTitle = fetchResult.title || processedContent.metadata?.title || "";
	const resolvedDescription =
		fetchResult.description || processedContent.metadata?.description || "";
	const robotsDirectives = mergeRobotsDirectives(
		processedContent.metadata?.robots,
		fetchResult.xRobotsTag,
	);
	const retainedMedia =
		options.saveMedia && (options.crawlMethod === "media" || options.crawlMethod === "full")
			? (processedContent.media ?? [])
			: [];
	const mainContent = processedContent.extractedData?.mainContent ?? "";
	const crawlVisibleLinks = robotsDirectives.nofollow ? [] : crawlLinks;
	const processedContentForPage = {
		...processedContent,
		media: retainedMedia,
	};

	return {
		resolvedTitle,
		resolvedDescription,
		mainContent,
		robotsDirectives,
		retainedMedia,
		mediaCount: retainedMedia.length,
		dataSizeKb: Math.floor(fetchResult.contentLength / 1024),
		saveInput: {
			crawlId,
			url: item.url,
			domain: item.domain,
			contentType: fetchResult.contentType,
			statusCode: fetchResult.statusCode,
			contentLength: fetchResult.contentLength,
			title: resolvedTitle,
			description: resolvedDescription,
			content:
				options.contentOnly || typeof fetchResult.content !== "string" ? null : fetchResult.content,
			isDynamic: fetchResult.isDynamic,
			lastModified: fetchResult.lastModified,
			etag: fetchResult.etag,
			processedContent: processedContentForPage,
			links: crawlVisibleLinks,
		},
		eventPayload: {
			url: item.url,
			title: resolvedTitle,
			description: resolvedDescription,
			contentType: fetchResult.contentType,
			domain: item.domain,
			processedData: {
				extractedData: omitUndefined({
					mainContent: processedContent.extractedData?.mainContent,
					jsonLd: processedContent.extractedData?.jsonLd ?? [],
					microdata: processedContent.extractedData?.microdata,
					openGraph: processedContent.extractedData?.openGraph,
					twitterCards: processedContent.extractedData?.twitterCards,
					schema: processedContent.extractedData?.schema,
				}),
				metadata: processedContent.metadata,
				analysis: processedContent.analysis,
				media: retainedMedia,
				errors: processedContent.errors,
				qualityScore: processedContent.analysis?.quality?.score ?? 0,
				language: processedContent.analysis?.language ?? "unknown",
			},
		},
	};
}
