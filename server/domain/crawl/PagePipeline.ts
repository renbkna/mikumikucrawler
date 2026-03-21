import { SOFT_404_CONSTANTS } from "../../constants.js";
import type { CrawlOptions } from "../../contracts/crawl.js";
import type { CrawlPagePayload } from "../../contracts/events.js";
import { ContentProcessor } from "../../processors/ContentProcessor.js";
import type { ExtractedLink } from "../../types.js";
import type { PageRepo } from "../../storage/repos/pageRepo.js";
import type { CrawlQueue, QueueItem } from "./CrawlQueue.js";
import type { CrawlState } from "./CrawlState.js";
import type { FetchService } from "./FetchService.js";
import type { RobotsService } from "./RobotsService.js";
import { filterDiscoveredLinks } from "./UrlPolicy.js";

interface EventSink {
	log(message: string): void;
	page(payload: CrawlPagePayload): void;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) {
		return;
	}

	if (signal.reason instanceof Error) {
		throw signal.reason;
	}

	throw new Error("Page processing aborted");
}

function parseRobotsDirectives(value: string | null | undefined) {
	const result = { noindex: false, nofollow: false };
	if (!value) return result;

	const normalized = value
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)
		.join(",");

	result.noindex = /\bnoindex\b|\bnone\b/.test(normalized);
	result.nofollow = /\bnofollow\b|\bnone\b/.test(normalized);
	return result;
}

function mergeRobotsDirectives(
	metaRobots: string | undefined,
	header: string | null,
) {
	const fromMeta = parseRobotsDirectives(metaRobots);
	const fromHeader = parseRobotsDirectives(header);
	return {
		noindex: fromMeta.noindex || fromHeader.noindex,
		nofollow: fromMeta.nofollow || fromHeader.nofollow,
	};
}

function isSoft404(
	title: string,
	mainContent: string,
	contentLength: number,
): boolean {
	if (
		contentLength > 0 &&
		contentLength < SOFT_404_CONSTANTS.TINY_CONTENT_BYTES
	) {
		return true;
	}

	const titleLower = title.toLowerCase();
	if (
		SOFT_404_CONSTANTS.KEYWORDS.some((keyword) => titleLower.includes(keyword))
	) {
		return true;
	}

	if (contentLength < SOFT_404_CONSTANTS.SHORT_CONTENT_BYTES) {
		const contentLower = mainContent.toLowerCase().slice(0, 1000);
		if (
			SOFT_404_CONSTANTS.KEYWORDS.some((keyword) =>
				contentLower.includes(keyword),
			)
		) {
			return true;
		}
	}

	return false;
}

export class PagePipeline {
	private readonly processor: ContentProcessor;

	constructor(
		private readonly crawlId: string,
		private readonly options: CrawlOptions,
		private readonly state: CrawlState,
		private readonly queue: CrawlQueue,
		private readonly pageRepo: PageRepo,
		private readonly fetchService: FetchService,
		private readonly robotsService: RobotsService,
		private readonly eventSink: EventSink,
		logger: import("../../config/logging.js").Logger,
	) {
		this.processor = new ContentProcessor(logger);
	}

	private async enqueueLinks(
		item: QueueItem,
		links: ExtractedLink[],
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		if (item.depth >= this.options.crawlDepth) {
			return;
		}

		for (const link of links) {
			throwIfAborted(signal);
			if (!link.url || link.nofollow) {
				continue;
			}

			if (this.options.respectRobots) {
				const linkPolicy = await this.robotsService.evaluate(link.url);
				if (!linkPolicy.allowed) {
					continue;
				}

				if (linkPolicy.crawlDelayMs !== undefined) {
					this.state.setDomainDelay(linkPolicy.domain, linkPolicy.crawlDelayMs);
				}
			}

			this.queue.enqueue({
				url: link.url,
				depth: item.depth + 1,
				retries: 0,
				parentUrl: item.url,
			});
		}
	}

	async process(item: QueueItem, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (!this.state.canScheduleMore() && !this.state.hasVisited(item.url)) {
			this.state.recordTerminal(item.url, "skip");
			this.eventSink.log(`[Limit] Max pages reached: ${item.url}`);
			return;
		}

		if (this.state.hasVisited(item.url)) {
			return;
		}

		if (this.state.isDomainBudgetExceeded(item.domain)) {
			this.state.recordTerminal(item.url, "skip");
			this.eventSink.log(`[Budget] Domain budget exceeded: ${item.url}`);
			return;
		}

		const fetchResult = await this.fetchService.fetch(
			this.crawlId,
			item,
			signal,
		);
		throwIfAborted(signal);
		if (fetchResult.type === "unchanged") {
			this.state.recordTerminal(item.url, "success");
			const cachedLinks = this.pageRepo.getLinksByPageUrl(
				this.crawlId,
				item.url,
			);
			await this.enqueueLinks(
				item,
				cachedLinks.map((url) => ({ url, isInternal: true })),
				signal,
			);
			throwIfAborted(signal);
			this.eventSink.log(`[Crawler] Unchanged: ${item.url} (304)`);
			return;
		}

		if (fetchResult.type === "rateLimited") {
			this.state.adaptDomainDelay(
				item.domain,
				fetchResult.statusCode,
				fetchResult.retryAfterMs,
			);
			if (
				item.retries < this.options.retryLimit &&
				!this.state.isStopRequested &&
				!signal?.aborted
			) {
				this.queue.scheduleRetry(item, fetchResult.retryAfterMs);
				this.eventSink.log(
					`[Crawler] Rate limited: ${item.url} — retrying in ${Math.round(fetchResult.retryAfterMs / 1000)}s`,
				);
				return;
			}

			this.state.recordTerminal(item.url, "failure");
			this.eventSink.log(
				`[Crawler] Rate limited terminal failure: ${item.url}`,
			);
			return;
		}

		if (
			fetchResult.type === "permanentFailure" ||
			fetchResult.type === "blocked"
		) {
			this.state.adaptDomainDelay(item.domain, fetchResult.statusCode);
			this.state.recordTerminal(item.url, "failure");
			if (fetchResult.type === "blocked" && fetchResult.reason) {
				this.eventSink.log(`[Crawler] ${fetchResult.reason}`);
			} else {
				this.eventSink.log(
					`[Crawler] Failed ${item.url} with ${fetchResult.statusCode}`,
				);
			}
			return;
		}

		const processedContent = await this.processor.processContent(
			fetchResult.content,
			item.url,
			fetchResult.contentType,
		);
		throwIfAborted(signal);

		const resolvedTitle =
			fetchResult.title || processedContent.metadata?.title || "";
		const resolvedDescription =
			fetchResult.description || processedContent.metadata?.description || "";

		const filteredLinks =
			fetchResult.contentType.includes("text/html") &&
			processedContent.links?.length
				? filterDiscoveredLinks(
						processedContent.links,
						this.options,
						item.domain,
					)
				: [];

		this.state.recordDiscoveredLinks(processedContent.links?.length ?? 0);

		const retainedMedia =
			this.options.saveMedia &&
			(this.options.crawlMethod === "media" ||
				this.options.crawlMethod === "full")
				? (processedContent.media ?? [])
				: [];
		const mediaCount = retainedMedia.length;

		const robotsDirectives = mergeRobotsDirectives(
			processedContent.metadata?.robots,
			fetchResult.xRobotsTag,
		);
		const mainContent = processedContent.extractedData?.mainContent ?? "";

		if (robotsDirectives.noindex) {
			this.state.recordTerminal(item.url, "skip");
			this.eventSink.log(`[Robots] noindex: ${item.url}`);
			if (!robotsDirectives.nofollow) {
				await this.enqueueLinks(item, filteredLinks, signal);
			}
			return;
		}

		if (isSoft404(resolvedTitle, mainContent, fetchResult.contentLength)) {
			this.state.recordTerminal(item.url, "skip");
			this.eventSink.log(`[Crawler] Soft 404 skipped: ${item.url}`);
			return;
		}

		throwIfAborted(signal);
		const pageId = this.pageRepo.save({
			crawlId: this.crawlId,
			url: item.url,
			domain: item.domain,
			contentType: fetchResult.contentType,
			statusCode: fetchResult.statusCode,
			contentLength: fetchResult.contentLength,
			title: resolvedTitle,
			description: resolvedDescription,
			content: this.options.contentOnly ? null : fetchResult.content,
			isDynamic: fetchResult.isDynamic,
			lastModified: fetchResult.lastModified,
			etag: fetchResult.etag,
			processedContent: {
				...processedContent,
				media: retainedMedia,
			},
			links: filteredLinks,
		});

		this.state.recordDomainPage(item.domain);
		this.state.recordTerminal(item.url, "success", {
			dataKb: Math.floor(fetchResult.contentLength / 1024),
			mediaFiles: mediaCount,
		});

		this.eventSink.page({
			id: pageId,
			url: item.url,
			title: resolvedTitle,
			description: resolvedDescription,
			contentType: fetchResult.contentType,
			domain: item.domain,
			processedData: {
				extractedData: {
					mainContent: processedContent.extractedData?.mainContent,
					jsonLd: processedContent.extractedData?.jsonLd ?? [],
					microdata: processedContent.extractedData?.microdata,
					openGraph: processedContent.extractedData?.openGraph,
					twitterCards: processedContent.extractedData?.twitterCards,
					schema: processedContent.extractedData?.schema,
				},
				metadata: processedContent.metadata,
				analysis: processedContent.analysis,
				media: retainedMedia,
				qualityScore: processedContent.analysis?.quality?.score ?? 0,
				language: processedContent.analysis?.language ?? "unknown",
			},
		});

		this.eventSink.log(`[Crawler] Crawled ${item.url}`);
		if (!robotsDirectives.nofollow) {
			await this.enqueueLinks(item, filteredLinks, signal);
		}
	}
}
