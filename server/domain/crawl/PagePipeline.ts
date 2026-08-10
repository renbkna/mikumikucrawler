import { setTimeout as sleep } from "node:timers/promises";
import type { CrawlLogLevel, CrawlOptions } from "../../../shared/contracts/index.js";
import { CRAWL_QUEUE_CONSTANTS, RETRY_CONSTANTS } from "../../constants.js";
import { OutboundPolicyError } from "../../outbound/HttpClient.js";
import { processContent } from "../../processors/ContentProcessor.js";
import { isHtmlLikeContentType } from "../../processors/contentTypes.js";
import { OperationTimeoutError, runWithTimeout } from "../../utils/timeout.js";
import {
	CrawlAdmissionPolicy,
	type CrawlAdmissionQueue,
	type CrawlAdmissionState,
	type RobotsPolicyEvaluator,
} from "./CrawlAdmissionPolicy.js";
import type { CrawlQueue, QueueItem } from "./CrawlQueue.js";
import type { CrawlState, TerminalOutcome } from "./CrawlState.js";
import type { DestinationAuthorizer, FetchService } from "./FetchService.js";
import { hasUsablePageContent, isClientErrorShell, isSoft404 } from "./PageDecisionPolicy.js";
import type { BuiltPageResult } from "./PageResultBuilder.js";
import { buildPageResult } from "./PageResultBuilder.js";
import { getCrawlUrlIdentity } from "./UrlPolicy.js";

type PagePipelineState = CrawlAdmissionState &
	Pick<
		CrawlState,
		| "adaptDomainDelay"
		| "hasPageCapacity"
		| "hasVisited"
		| "isDomainBudgetExceeded"
		| "reserveDomain"
		| "timeUntilDomainReady"
		| "tryReserveRedirectDomain"
	>;
type PagePipelineQueue = CrawlAdmissionQueue & Pick<CrawlQueue, "scheduleRetry">;
type PageFetcher = Pick<FetchService, "fetch">;

interface EventSink {
	log(message: string, level?: CrawlLogLevel): void;
}

interface TerminalEffects {
	chargeDomainBudget: boolean;
	chargedDomain?: string;
}

interface NonTerminalPageResult {
	terminalOutcome?: never;
	terminalEffects?: never;
	page?: never;
}

interface AttemptContext {
	chargedDomain: string;
}

export class PagePipelineError extends Error {
	constructor(
		message: string,
		options: ErrorOptions,
		readonly chargedDomain?: string,
	) {
		super(message, options);
		this.name = "PagePipelineError";
	}
}

export type PageProcessResult =
	| (NonTerminalPageResult & { rescheduled: true; aborted?: never })
	| (NonTerminalPageResult & { aborted: true; rescheduled?: never })
	| {
			terminalOutcome: Exclude<TerminalOutcome, "success">;
			terminalEffects: TerminalEffects;
			page?: never;
			aborted?: never;
			rescheduled?: never;
	  }
	| {
			terminalOutcome: "success";
			terminalEffects: TerminalEffects;
			page: Pick<BuiltPageResult, "pageData" | "eventPayload">;
			aborted?: never;
			rescheduled?: never;
	  };

function retryDelayMs(result: { retryAfterMs?: number }, retries: number): number {
	return (
		result.retryAfterMs ??
		Math.min(RETRY_CONSTANTS.BASE_DELAY * 2 ** retries, RETRY_CONSTANTS.MAX_DELAY)
	);
}

export class PagePipeline {
	private readonly admissionPolicy: CrawlAdmissionPolicy;

	constructor(
		private readonly options: CrawlOptions,
		private readonly state: PagePipelineState,
		private readonly queue: PagePipelineQueue,
		private readonly fetchService: PageFetcher,
		private readonly robotsService: RobotsPolicyEvaluator,
		private readonly eventSink: EventSink,
		private readonly logger: import("../../config/logging.js").Logger,
		private readonly localSeedUrl?: string,
		private readonly itemTimeoutMs: number = CRAWL_QUEUE_CONSTANTS.ITEM_PROCESSING_TIMEOUT_MS,
	) {
		this.admissionPolicy = new CrawlAdmissionPolicy(options, state, queue, robotsService);
	}

	private async enqueueLinks(
		item: QueueItem,
		links: ReturnType<CrawlAdmissionPolicy["normalizeDiscoveredLinks"]>,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		await this.admissionPolicy.admitNormalizedDiscoveredLinks(item, links, signal);
	}

	private recordTerminal(
		outcome: Exclude<TerminalOutcome, "success">,
	): Extract<PageProcessResult, { terminalOutcome: "failure" | "skip" }> {
		return {
			terminalOutcome: outcome,
			terminalEffects: { chargeDomainBudget: false },
		};
	}

	private recordFetchedTerminal(
		outcome: Exclude<TerminalOutcome, "success">,
		chargedDomain?: string,
	): Extract<PageProcessResult, { terminalOutcome: "failure" | "skip" }> {
		return {
			terminalOutcome: outcome,
			terminalEffects: {
				chargeDomainBudget: true,
				...(chargedDomain ? { chargedDomain } : {}),
			},
		};
	}

	private createDestinationAuthorizer(
		item: QueueItem,
		onDomainAuthorized: (domain: string) => void,
	): DestinationAuthorizer {
		const sourceIdentity = getCrawlUrlIdentity(item.url);
		if ("error" in sourceIdentity) throw new Error(sourceIdentity.error);

		return async (destinationUrl: string, signal?: AbortSignal) => {
			const destination = getCrawlUrlIdentity(destinationUrl);
			if ("error" in destination) {
				throw new OutboundPolicyError("crawl-policy", destination.error);
			}
			if (
				this.options.crawlMethod !== "full" &&
				destination.originKey !== sourceIdentity.originKey
			) {
				throw new OutboundPolicyError(
					"crawl-policy",
					`Cross-origin document navigation requires full crawl mode: ${destinationUrl}`,
				);
			}

			if (this.options.respectRobots) {
				const policy = await this.robotsService.evaluateIdentity(destination, signal);
				if (policy.type === "blocked" || policy.type === "disallowed") {
					throw new OutboundPolicyError(
						"crawl-policy",
						policy.type === "blocked"
							? policy.reason
							: `Document destination is disallowed by robots.txt: ${destinationUrl}`,
					);
				}
				if (policy.type === "unavailable") {
					this.eventSink.log(
						`[Robots] Continuing because document-destination robots.txt is unavailable for ${destinationUrl}: ${policy.reason}`,
					);
				} else if (policy.crawlDelayMs !== undefined) {
					this.state.setDomainDelay(policy.delayKey, policy.crawlDelayMs);
				}
			}

			if (
				!this.state.tryReserveRedirectDomain(item.url, destination.domainBudgetKey, item.domain)
			) {
				throw new OutboundPolicyError(
					"crawl-policy",
					`Document destination domain budget exhausted: ${destination.domainBudgetKey}`,
				);
			}
			let waitMs = this.state.timeUntilDomainReady(destination.domainBudgetKey);
			while (waitMs > 0) {
				await sleep(waitMs, undefined, signal ? { signal } : undefined);
				waitMs = this.state.timeUntilDomainReady(destination.domainBudgetKey);
			}
			signal?.throwIfAborted();
			this.state.reserveDomain(destination.domainBudgetKey);
			onDomainAuthorized(destination.domainBudgetKey);
		};
	}

	async process(item: QueueItem, signal?: AbortSignal): Promise<PageProcessResult> {
		const context: AttemptContext = { chargedDomain: item.domain };
		try {
			return await runWithTimeout({
				timeoutMs: this.itemTimeoutMs,
				operationName: `Processing ${item.url}`,
				...(signal ? { signal } : {}),
				run: (attemptSignal) => this.processAttempt(item, attemptSignal, context),
			});
		} catch (error) {
			if (!(error instanceof OperationTimeoutError)) {
				signal?.throwIfAborted();
				throw new PagePipelineError(
					error instanceof Error ? error.message : String(error),
					{ cause: error },
					context.chargedDomain === item.domain ? undefined : context.chargedDomain,
				);
			}
			signal?.throwIfAborted();
			const delayMs = retryDelayMs({}, item.retries);
			if (item.retries < this.options.retryLimit) {
				this.queue.scheduleRetry(item, delayMs);
				this.eventSink.log(
					`[Crawler] Processing timeout: ${item.url} — retrying in ${Math.round(delayMs / 1000)}s`,
				);
				return { rescheduled: true };
			}
			this.eventSink.log(`[Crawler] Processing timeout terminal failure: ${item.url}`, "error");
			return this.recordFetchedTerminal(
				"failure",
				context.chargedDomain === item.domain ? undefined : context.chargedDomain,
			);
		}
	}

	private async processAttempt(
		item: QueueItem,
		signal: AbortSignal,
		context: AttemptContext,
	): Promise<PageProcessResult> {
		signal?.throwIfAborted();
		if (this.state.hasVisited(item.url)) {
			throw new Error(`Queued URL is already terminal: ${item.url}`);
		}

		if (!this.state.hasPageCapacity()) {
			const result = this.recordTerminal("skip");
			this.eventSink.log(`[Limit] Max pages reached: ${item.url}`);
			return result;
		}

		if (this.state.isDomainBudgetExceeded(item.domain)) {
			const result = this.recordTerminal("skip");
			this.eventSink.log(`[Budget] Domain budget exceeded: ${item.url}`);
			return result;
		}

		if (this.options.respectRobots) {
			const identity = getCrawlUrlIdentity(item.url);
			if ("error" in identity) {
				this.eventSink.log(`[Policy] Invalid queued URL: ${item.url}`, "error");
				return this.recordTerminal("failure");
			}
			const policy = await this.robotsService.evaluateIdentity(identity, signal, {
				allowLocalhostOnInitialRequest:
					this.localSeedUrl !== undefined && item.url === this.localSeedUrl,
			});
			signal?.throwIfAborted();
			if (policy.type === "blocked") {
				this.eventSink.log(
					`[Policy] Outbound request denied for ${item.url}: ${policy.reason}`,
					"error",
				);
				return this.recordTerminal("failure");
			}
			if (policy.type === "disallowed") {
				this.eventSink.log(`[Robots] Disallowed: ${item.url}`);
				return this.recordTerminal("skip");
			}
			if (policy.type === "unavailable") {
				this.eventSink.log(
					`[Robots] Continuing because robots.txt is unavailable for ${item.url}: ${policy.reason}`,
				);
			} else if (policy.crawlDelayMs !== undefined) {
				this.state.setDomainDelay(policy.delayKey, policy.crawlDelayMs);
			}
		}

		const fetchResult = await this.fetchService.fetch(
			item,
			signal,
			this.createDestinationAuthorizer(item, (domain) => {
				context.chargedDomain = domain;
			}),
		);
		const releasePdfWork = fetchResult.type === "success" ? fetchResult.releasePdfWork : undefined;
		try {
			const chargedDomainOverride = () =>
				context.chargedDomain === item.domain ? undefined : context.chargedDomain;
			signal?.throwIfAborted();
			if (fetchResult.type === "rateLimited" || fetchResult.type === "transientFailure") {
				const delayMs = retryDelayMs(fetchResult, item.retries);
				this.state.adaptDomainDelay(context.chargedDomain, fetchResult.statusCode, delayMs);
				if (item.retries < this.options.retryLimit && !signal.aborted) {
					this.queue.scheduleRetry(item, delayMs);
					this.eventSink.log(
						`[Crawler] ${fetchResult.type === "rateLimited" ? "Rate limited" : "Transient failure"}: ${item.url} — retrying in ${Math.round(delayMs / 1000)}s`,
					);
					return { rescheduled: true };
				}

				const result = this.recordFetchedTerminal("failure", chargedDomainOverride());
				this.eventSink.log(
					`[Crawler] ${fetchResult.type === "rateLimited" ? "Rate limited" : "Transient failure"} terminal failure: ${item.url}`,
					"error",
				);
				return result;
			}

			if (fetchResult.type === "permanentFailure" || fetchResult.type === "blocked") {
				this.state.adaptDomainDelay(context.chargedDomain, fetchResult.statusCode);
				const result = this.recordFetchedTerminal("failure", chargedDomainOverride());
				if (fetchResult.type === "blocked" && fetchResult.reason) {
					this.eventSink.log(`[Crawler] ${fetchResult.reason}`, "error");
				} else {
					this.eventSink.log(
						`[Crawler] Failed ${item.url} with ${fetchResult.statusCode}`,
						"error",
					);
				}
				return result;
			}

			if (fetchResult.type === "unsupported") {
				const result = this.recordFetchedTerminal("skip", chargedDomainOverride());
				this.eventSink.log(
					`[Crawler] Unsupported content type ${fetchResult.contentType || "(missing)"}: ${item.url}`,
				);
				return result;
			}

			// Queue/page identity remains the requested item URL. The validated effective URL
			// owns document-base resolution and link-origin classification.
			const processedContent = await processContent(
				fetchResult.content,
				fetchResult.effectiveUrl,
				fetchResult.contentType,
				this.logger,
				signal,
			);
			signal?.throwIfAborted();
			if (processedContent.errors.length > 0) {
				const result = this.recordFetchedTerminal("failure", chargedDomainOverride());
				this.eventSink.log(`[Crawler] Content processing failed: ${item.url}`, "error");
				return result;
			}
			const mainContent = processedContent.extractedData.mainContent ?? "";
			if (!hasUsablePageContent(fetchResult.contentType, mainContent)) {
				const result = this.recordFetchedTerminal("failure", chargedDomainOverride());
				this.eventSink.log(`[Crawler] No usable page content: ${item.url}`, "error");
				return result;
			}

			const normalizedCrawlLinks =
				isHtmlLikeContentType(fetchResult.contentType) && processedContent.links.length
					? this.admissionPolicy.normalizeDiscoveredLinks(
							fetchResult.effectiveUrl,
							processedContent.links,
						)
					: [];
			const pageResult = buildPageResult(this.options, item, fetchResult, processedContent);

			if (isClientErrorShell(pageResult.pageData.title, pageResult.pageData.mainContent)) {
				const result = this.recordFetchedTerminal("failure", chargedDomainOverride());
				this.eventSink.log(`[Crawler] Client error shell detected: ${item.url}`, "error");
				return result;
			}

			if (pageResult.robotsDirectives.noindex) {
				this.eventSink.log(`[Robots] noindex: ${item.url}`);
				if (!pageResult.robotsDirectives.nofollow) {
					await this.enqueueLinks(item, normalizedCrawlLinks, signal);
					signal?.throwIfAborted();
				}
				const result = this.recordFetchedTerminal("skip", chargedDomainOverride());
				return result;
			}

			if (
				isSoft404(
					pageResult.pageData.title,
					pageResult.pageData.mainContent,
					fetchResult.contentLength,
				)
			) {
				const result = this.recordFetchedTerminal("skip", chargedDomainOverride());
				this.eventSink.log(`[Crawler] Soft 404 skipped: ${item.url}`);
				return result;
			}

			signal?.throwIfAborted();

			if (!pageResult.robotsDirectives.nofollow) {
				await this.enqueueLinks(item, normalizedCrawlLinks, signal);
			}

			this.eventSink.log(`[Crawler] Crawled ${item.url}`, "success");
			return {
				terminalOutcome: "success",
				terminalEffects: {
					chargeDomainBudget: true,
					...(chargedDomainOverride() ? { chargedDomain: context.chargedDomain } : {}),
				},
				page: {
					pageData: pageResult.pageData,
					eventPayload: pageResult.eventPayload,
				},
			};
		} finally {
			releasePdfWork?.();
		}
	}
}
