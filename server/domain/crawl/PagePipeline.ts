import type { CrawlOptions } from "../../../shared/contracts/crawl.js";
import { ContentProcessor } from "../../processors/ContentProcessor.js";
import { isHtmlLikeContentType } from "../../processors/contentTypes.js";
import type { ExtractedLink } from "../../../shared/types.js";
import type { PageRepo } from "../../storage/repos/pageRepo.js";
import { CrawlAdmissionPolicy } from "./CrawlAdmissionPolicy.js";
import type { CrawlQueue, QueueItem } from "./CrawlQueue.js";
import type { CrawlState, TerminalOutcome } from "./CrawlState.js";
import type { FetchService } from "./FetchService.js";
import type { BuiltPageResult } from "./PageResultBuilder.js";
import { PageResultBuilder } from "./PageResultBuilder.js";
import { isClientErrorShell, isSoft404 } from "./PageDecisionPolicy.js";
import type { RobotsService } from "./RobotsService.js";
import { getCrawlUrlIdentity } from "./UrlPolicy.js";

interface EventSink {
	log(message: string): void;
}

export interface PageProcessResult {
	terminalOutcome?: TerminalOutcome;
	domainBudgetCharged?: boolean;
	rescheduled?: boolean;
	aborted?: boolean;
	page?: Pick<BuiltPageResult, "saveInput" | "eventPayload">;
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

function getDelayKey(item: QueueItem): string {
	const identity = getCrawlUrlIdentity(item.url);
	return "error" in identity ? item.domain : identity.originKey;
}

export class PagePipeline {
	private readonly processor: ContentProcessor;
	private readonly admissionPolicy: CrawlAdmissionPolicy;
	private readonly resultBuilder: PageResultBuilder;

	constructor(
		private readonly crawlId: string,
		private readonly options: CrawlOptions,
		private readonly state: CrawlState,
		private readonly queue: CrawlQueue,
		private readonly pageRepo: PageRepo,
		private readonly fetchService: FetchService,
		robotsService: RobotsService,
		private readonly eventSink: EventSink,
		logger: import("../../config/logging.js").Logger,
	) {
		this.processor = new ContentProcessor(logger);
		this.resultBuilder = new PageResultBuilder(crawlId, options);
		this.admissionPolicy = new CrawlAdmissionPolicy(
			options,
			state,
			queue,
			robotsService,
		);
	}

	private async enqueueLinks(
		item: QueueItem,
		links: ExtractedLink[],
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		await this.admissionPolicy.admitDiscoveredLinks(item, links, signal);
	}

	private recordTerminal(
		url: string,
		outcome: TerminalOutcome,
		options: { dataKb?: number; mediaFiles?: number } = {},
	): PageProcessResult {
		if (Object.keys(options).length > 0) {
			this.state.recordTerminal(url, outcome, options);
		} else {
			this.state.recordTerminal(url, outcome);
		}
		return { terminalOutcome: outcome };
	}

	private recordFetchedTerminal(
		item: QueueItem,
		outcome: TerminalOutcome,
		options: { dataKb?: number; mediaFiles?: number } = {},
	): PageProcessResult {
		const recorded =
			Object.keys(options).length > 0
				? this.state.recordTerminal(item.url, outcome, options)
				: this.state.recordTerminal(item.url, outcome);
		if (recorded) {
			this.state.recordDomainPage(item.domain);
		}
		return { terminalOutcome: outcome, domainBudgetCharged: recorded };
	}

	async process(
		item: QueueItem,
		signal?: AbortSignal,
	): Promise<PageProcessResult> {
		throwIfAborted(signal);
		if (!this.state.canScheduleMore() && !this.state.hasVisited(item.url)) {
			const result = this.recordTerminal(item.url, "skip");
			this.eventSink.log(`[Limit] Max pages reached: ${item.url}`);
			return result;
		}

		if (this.state.hasVisited(item.url)) {
			return {};
		}

		if (this.state.isDomainBudgetExceeded(item.domain)) {
			const result = this.recordTerminal(item.url, "skip");
			this.eventSink.log(`[Budget] Domain budget exceeded: ${item.url}`);
			return result;
		}

		const fetchResult = await this.fetchService.fetch(
			this.crawlId,
			item,
			signal,
		);
		throwIfAborted(signal);
		if (fetchResult.type === "unchanged") {
			const cachedLinks = this.pageRepo.getLinksByPageUrl(
				this.crawlId,
				item.url,
			);
			const discoveredLinkCount =
				this.pageRepo.getDiscoveredLinkCountByPageUrl?.(
					this.crawlId,
					item.url,
				) ?? cachedLinks.length;
			await this.enqueueLinks(item, cachedLinks, signal);
			throwIfAborted(signal);
			this.state.recordDiscoveredLinks(discoveredLinkCount);
			const result = this.recordFetchedTerminal(item, "success");
			this.eventSink.log(`[Crawler] Unchanged: ${item.url} (304)`);
			return result;
		}

		if (fetchResult.type === "rateLimited") {
			this.state.adaptDomainDelay(
				getDelayKey(item),
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
				return { rescheduled: true };
			}

			const result = this.recordFetchedTerminal(item, "failure");
			this.eventSink.log(
				`[Crawler] Rate limited terminal failure: ${item.url}`,
			);
			return result;
		}

		if (
			fetchResult.type === "permanentFailure" ||
			fetchResult.type === "blocked"
		) {
			this.state.adaptDomainDelay(getDelayKey(item), fetchResult.statusCode);
			const result = this.recordFetchedTerminal(item, "failure");
			if (fetchResult.type === "blocked" && fetchResult.reason) {
				this.eventSink.log(`[Crawler] ${fetchResult.reason}`);
			} else {
				this.eventSink.log(
					`[Crawler] Failed ${item.url} with ${fetchResult.statusCode}`,
				);
			}
			return result;
		}

		const processedContent = await this.processor.processContent(
			fetchResult.content,
			item.url,
			fetchResult.contentType,
		);
		throwIfAborted(signal);

		const crawlLinks =
			isHtmlLikeContentType(fetchResult.contentType) &&
			processedContent.links?.length
				? this.admissionPolicy
						.normalizeDiscoveredLinks(item, processedContent.links)
						.map((link) => link.link)
				: [];
		const pageResult = this.resultBuilder.build(
			item,
			fetchResult,
			processedContent,
			crawlLinks,
		);

		if (isClientErrorShell(pageResult.resolvedTitle, pageResult.mainContent)) {
			const result = this.recordFetchedTerminal(item, "failure");
			this.eventSink.log(`[Crawler] Client error shell detected: ${item.url}`);
			return result;
		}

		if (pageResult.robotsDirectives.noindex) {
			this.eventSink.log(`[Robots] noindex: ${item.url}`);
			if (!pageResult.robotsDirectives.nofollow) {
				await this.enqueueLinks(item, crawlLinks, signal);
				throwIfAborted(signal);
			}
			this.state.recordDiscoveredLinks(processedContent.links?.length ?? 0);
			const result = this.recordFetchedTerminal(item, "skip");
			return result;
		}

		if (
			isSoft404(
				pageResult.resolvedTitle,
				pageResult.mainContent,
				fetchResult.contentLength,
			)
		) {
			const result = this.recordFetchedTerminal(item, "skip");
			this.eventSink.log(`[Crawler] Soft 404 skipped: ${item.url}`);
			return result;
		}

		throwIfAborted(signal);

		if (!pageResult.robotsDirectives.nofollow) {
			await this.enqueueLinks(item, crawlLinks, signal);
		}

		this.state.recordDiscoveredLinks(processedContent.links?.length ?? 0);
		const result = this.recordFetchedTerminal(item, "success", {
			dataKb: pageResult.dataSizeKb,
			mediaFiles: pageResult.mediaCount,
		});

		this.eventSink.log(`[Crawler] Crawled ${item.url}`);
		return {
			...result,
			page: {
				saveInput: pageResult.saveInput,
				eventPayload: pageResult.eventPayload,
			},
		};
	}
}
