import type { CrawlOptions } from "../../../shared/contracts/index.js";
import { RETRY_CONSTANTS } from "../../constants.js";
import { processContent } from "../../processors/ContentProcessor.js";
import { isHtmlLikeContentType } from "../../processors/contentTypes.js";
import type { PageRepo } from "../../storage/repos/pageRepo.js";
import { CrawlAdmissionPolicy } from "./CrawlAdmissionPolicy.js";
import type { CrawlQueue, QueueItem } from "./CrawlQueue.js";
import type { CrawlState, TerminalOutcome } from "./CrawlState.js";
import type { FetchService } from "./FetchService.js";
import type { BuiltPageResult } from "./PageResultBuilder.js";
import { buildPageResult } from "./PageResultBuilder.js";
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

function retryDelayMs(
	result: { retryAfterMs?: number },
	retries: number,
): number {
	return (
		result.retryAfterMs ??
		Math.min(
			RETRY_CONSTANTS.BASE_DELAY * 2 ** retries,
			RETRY_CONSTANTS.MAX_DELAY,
		)
	);
}

export class PagePipeline {
	private readonly admissionPolicy: CrawlAdmissionPolicy;

	constructor(
		private readonly crawlId: string,
		private readonly options: CrawlOptions,
		private readonly state: CrawlState,
		private readonly queue: CrawlQueue,
		private readonly pageRepo: PageRepo,
		private readonly fetchService: FetchService,
		robotsService: RobotsService,
		private readonly eventSink: EventSink,
		private readonly logger: import("../../config/logging.js").Logger,
	) {
		this.admissionPolicy = new CrawlAdmissionPolicy(
			options,
			state,
			queue,
			robotsService,
		);
	}

	private async enqueueLinks(
		item: QueueItem,
		links: ReturnType<CrawlAdmissionPolicy["normalizeDiscoveredLinks"]>,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		await this.admissionPolicy.admitNormalizedDiscoveredLinks(
			item,
			links,
			signal,
		);
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
			const cachedLinks = this.admissionPolicy.normalizeDiscoveredLinks(
				item,
				this.pageRepo.getLinksByPageUrl(this.crawlId, item.url),
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

		if (
			fetchResult.type === "rateLimited" ||
			fetchResult.type === "transientFailure"
		) {
			const delayMs = retryDelayMs(fetchResult, item.retries);
			this.state.adaptDomainDelay(
				getDelayKey(item),
				fetchResult.statusCode,
				delayMs,
			);
			if (
				item.retries < this.options.retryLimit &&
				!this.state.isStopRequested &&
				!signal?.aborted
			) {
				this.queue.scheduleRetry(item, delayMs);
				this.eventSink.log(
					`[Crawler] ${fetchResult.type === "rateLimited" ? "Rate limited" : "Transient failure"}: ${item.url} — retrying in ${Math.round(delayMs / 1000)}s`,
				);
				return { rescheduled: true };
			}

			const result = this.recordFetchedTerminal(item, "failure");
			this.eventSink.log(
				`[Crawler] ${fetchResult.type === "rateLimited" ? "Rate limited" : "Transient failure"} terminal failure: ${item.url}`,
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

		const processedContent = await processContent(
			fetchResult.content,
			item.url,
			fetchResult.contentType,
			this.logger,
		);
		throwIfAborted(signal);

		const normalizedCrawlLinks =
			isHtmlLikeContentType(fetchResult.contentType) &&
			processedContent.links?.length
				? this.admissionPolicy.normalizeDiscoveredLinks(
						item,
						processedContent.links,
					)
				: [];
		const pageResult = buildPageResult(
			this.crawlId,
			this.options,
			item,
			fetchResult,
			processedContent,
			normalizedCrawlLinks.map((link) => link.link),
		);

		if (isClientErrorShell(pageResult.resolvedTitle, pageResult.mainContent)) {
			const result = this.recordFetchedTerminal(item, "failure");
			this.eventSink.log(`[Crawler] Client error shell detected: ${item.url}`);
			return result;
		}

		if (pageResult.robotsDirectives.noindex) {
			this.eventSink.log(`[Robots] noindex: ${item.url}`);
			if (!pageResult.robotsDirectives.nofollow) {
				await this.enqueueLinks(item, normalizedCrawlLinks, signal);
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
			await this.enqueueLinks(item, normalizedCrawlLinks, signal);
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
