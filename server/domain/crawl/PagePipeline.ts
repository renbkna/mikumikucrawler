import { setTimeout as sleep } from "node:timers/promises";
import type { CrawlLogLevel, CrawlOptions } from "../../../shared/contracts/index.js";
import type { Logger } from "../../config/logging.js";
import { CRAWL_QUEUE_CONSTANTS, RETRY_CONSTANTS } from "../../constants.js";
import { OutboundPolicyError } from "../../outbound/HttpClient.js";
import { processContent } from "../../processors/ContentProcessor.js";
import { isHtmlLikeContentType } from "../../processors/contentTypes.js";
import { getErrorMessage } from "../../utils/helpers.js";
import { OperationTimeoutError, runWithTimeout } from "../../utils/timeout.js";
import {
	CrawlAdmissionPolicy,
	type CrawlAdmissionQueue,
	type CrawlAdmissionState,
	evaluateRobotsGate,
	type RobotsPolicyEvaluator,
} from "./CrawlAdmissionPolicy.js";
import type { CrawlQueue, QueueItem } from "./CrawlQueue.js";
import type { CrawlState } from "./CrawlState.js";
import type { TerminalOutcome } from "./completion.js";
import type { FetchService } from "./FetchService.js";
import { hasUsablePageContent, isClientErrorShell, isSoft404 } from "./PageDecisionPolicy.js";
import type { BuiltPageResult } from "./PageResultBuilder.js";
import { buildPageResult } from "./PageResultBuilder.js";
import type { DestinationAuthorizer } from "./rendering/contracts.js";
import { type CrawlUrlIdentity, getCrawlUrlIdentity } from "./UrlPolicy.js";

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
type PagePipelineQueue = CrawlAdmissionQueue & Pick<CrawlQueue, "tryScheduleRetry">;
type PageFetcher = Pick<FetchService, "fetch">;

interface EventSink {
	log(message: string, level?: CrawlLogLevel): void;
}

export interface PagePipelineDependencies {
	options: CrawlOptions;
	state: PagePipelineState;
	queue: PagePipelineQueue;
	fetchService: PageFetcher;
	robotsService: RobotsPolicyEvaluator;
	eventSink: EventSink;
	logger: Logger;
	/** The seed URL granted the localhost capability on its first request, if any. */
	localSeedUrl?: string;
	itemTimeoutMs?: number;
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

/** The domain an attempt is charged to; a redirect moves it to the destination's domain. */
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

type TerminalFailureOrSkip = Extract<PageProcessResult, { terminalOutcome: "failure" | "skip" }>;

function retryDelayMs(result: { retryAfterMs?: number }, retries: number): number {
	return (
		result.retryAfterMs ??
		Math.min(RETRY_CONSTANTS.BASE_DELAY * 2 ** retries, RETRY_CONSTANTS.MAX_DELAY)
	);
}

/** Only a redirect-moved charge is recorded; the queued domain is the default charge. */
function chargedDomainOverride(item: QueueItem, context: AttemptContext): string | undefined {
	return context.chargedDomain === item.domain ? undefined : context.chargedDomain;
}

function requireCrawlUrlIdentity(url: string): CrawlUrlIdentity {
	const identity = getCrawlUrlIdentity(url);
	if ("error" in identity) throw new Error(identity.error);
	return identity;
}

export class PagePipeline {
	private readonly admissionPolicy: CrawlAdmissionPolicy;
	private readonly itemTimeoutMs: number;

	constructor(private readonly deps: PagePipelineDependencies) {
		this.admissionPolicy = new CrawlAdmissionPolicy(
			deps.options,
			deps.state,
			deps.queue,
			deps.robotsService,
		);
		this.itemTimeoutMs = deps.itemTimeoutMs ?? CRAWL_QUEUE_CONSTANTS.ITEM_PROCESSING_TIMEOUT_MS;
	}

	private log(message: string, level: CrawlLogLevel | undefined): void {
		if (level) this.deps.eventSink.log(message, level);
		else this.deps.eventSink.log(message);
	}

	/** Ends the item before any response was fetched: nothing is charged to a domain budget. */
	private unfetchedTerminal(
		outcome: Exclude<TerminalOutcome, "success">,
		message: string,
		level?: CrawlLogLevel,
	): TerminalFailureOrSkip {
		this.log(message, level);
		return { terminalOutcome: outcome, terminalEffects: { chargeDomainBudget: false } };
	}

	/** Ends a fetched item: the attempt's charged domain pays for it. */
	private fetchedTerminal(
		outcome: Exclude<TerminalOutcome, "success">,
		chargedDomain: string | undefined,
		message: string,
		level?: CrawlLogLevel,
	): TerminalFailureOrSkip {
		this.log(message, level);
		return {
			terminalOutcome: outcome,
			terminalEffects: { chargeDomainBudget: true, ...(chargedDomain ? { chargedDomain } : {}) },
		};
	}

	private createDestinationAuthorizer(
		item: QueueItem,
		sourceIdentity: CrawlUrlIdentity,
		onDomainAuthorized: (domain: string) => void,
	): DestinationAuthorizer {
		const { options, state } = this.deps;
		return async (destinationUrl: string, signal?: AbortSignal) => {
			const destination = getCrawlUrlIdentity(destinationUrl);
			if ("error" in destination) {
				throw new OutboundPolicyError("crawl-policy", destination.error);
			}
			if (options.crawlMethod !== "full" && destination.originKey !== sourceIdentity.originKey) {
				throw new OutboundPolicyError(
					"crawl-policy",
					`Cross-origin document navigation requires full crawl mode: ${destinationUrl}`,
				);
			}

			const robots = await evaluateRobotsGate(this.deps, destination, signal);
			if (robots.type === "blocked") {
				throw new OutboundPolicyError("crawl-policy", robots.reason);
			}
			if (robots.type === "disallowed") {
				throw new OutboundPolicyError(
					"crawl-policy",
					`Document destination is disallowed by robots.txt: ${destinationUrl}`,
				);
			}
			if (robots.type === "unavailable") {
				this.deps.eventSink.log(
					`[Robots] Continuing because document-destination robots.txt is unavailable for ${destinationUrl}: ${robots.reason}`,
				);
			}

			if (!state.tryReserveRedirectDomain(item.url, destination.domainBudgetKey)) {
				throw new OutboundPolicyError(
					"crawl-policy",
					`Document destination domain budget exhausted: ${destination.domainBudgetKey}`,
				);
			}
			let waitMs = state.timeUntilDomainReady(destination.domainBudgetKey);
			while (waitMs > 0) {
				await sleep(waitMs, undefined, signal ? { signal } : undefined);
				waitMs = state.timeUntilDomainReady(destination.domainBudgetKey);
			}
			signal?.throwIfAborted();
			state.reserveDomain(destination.domainBudgetKey);
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
					getErrorMessage(error),
					{ cause: error },
					chargedDomainOverride(item, context),
				);
			}
			signal?.throwIfAborted();
			const delayMs = retryDelayMs({}, item.retries);
			if (this.deps.queue.tryScheduleRetry(item, delayMs)) {
				this.deps.eventSink.log(
					`[Crawler] Processing timeout: ${item.url} — retrying in ${Math.round(delayMs / 1000)}s`,
				);
				return { rescheduled: true };
			}
			return this.fetchedTerminal(
				"failure",
				chargedDomainOverride(item, context),
				`[Crawler] Processing timeout terminal failure: ${item.url}`,
				"error",
			);
		}
	}

	private async processAttempt(
		item: QueueItem,
		signal: AbortSignal,
		context: AttemptContext,
	): Promise<PageProcessResult> {
		const { options, state, queue, eventSink } = this.deps;
		signal.throwIfAborted();
		if (state.hasVisited(item.url)) {
			throw new Error(`Queued URL is already terminal: ${item.url}`);
		}
		if (!state.hasPageCapacity()) {
			return this.unfetchedTerminal("skip", `[Limit] Max pages reached: ${item.url}`);
		}
		if (state.isDomainBudgetExceeded(item.domain)) {
			return this.unfetchedTerminal("skip", `[Budget] Domain budget exceeded: ${item.url}`);
		}

		const identity = requireCrawlUrlIdentity(item.url);
		const robots = await evaluateRobotsGate(this.deps, identity, signal, {
			allowLocalhostOnInitialRequest: item.url === this.deps.localSeedUrl,
		});
		signal.throwIfAborted();
		if (robots.type === "blocked") {
			return this.unfetchedTerminal(
				"failure",
				`[Policy] Outbound request denied for ${item.url}: ${robots.reason}`,
				"error",
			);
		}
		if (robots.type === "disallowed") {
			return this.unfetchedTerminal("skip", `[Robots] Disallowed: ${item.url}`);
		}
		if (robots.type === "unavailable") {
			eventSink.log(
				`[Robots] Continuing because robots.txt is unavailable for ${item.url}: ${robots.reason}`,
			);
		}

		const fetchResult = await this.deps.fetchService.fetch(
			item,
			signal,
			this.createDestinationAuthorizer(item, identity, (domain) => {
				context.chargedDomain = domain;
			}),
		);
		const releasePdfWork = fetchResult.type === "success" ? fetchResult.releasePdfWork : undefined;
		try {
			const terminal = (
				outcome: Exclude<TerminalOutcome, "success">,
				message: string,
				level?: CrawlLogLevel,
			) => this.fetchedTerminal(outcome, chargedDomainOverride(item, context), message, level);
			signal.throwIfAborted();
			if (fetchResult.type === "rateLimited" || fetchResult.type === "transientFailure") {
				const label = fetchResult.type === "rateLimited" ? "Rate limited" : "Transient failure";
				const delayMs = retryDelayMs(fetchResult, item.retries);
				state.adaptDomainDelay(context.chargedDomain, fetchResult.statusCode, delayMs);
				if (!signal.aborted && queue.tryScheduleRetry(item, delayMs)) {
					eventSink.log(
						`[Crawler] ${label}: ${item.url} — retrying in ${Math.round(delayMs / 1000)}s`,
					);
					return { rescheduled: true };
				}
				return terminal("failure", `[Crawler] ${label} terminal failure: ${item.url}`, "error");
			}

			if (fetchResult.type === "permanentFailure" || fetchResult.type === "blocked") {
				state.adaptDomainDelay(context.chargedDomain, fetchResult.statusCode);
				const message =
					fetchResult.type === "blocked" && fetchResult.reason
						? `[Crawler] ${fetchResult.reason}`
						: `[Crawler] Failed ${item.url} with ${fetchResult.statusCode}`;
				return terminal("failure", message, "error");
			}

			if (fetchResult.type === "unsupported") {
				return terminal(
					"skip",
					`[Crawler] Unsupported content type ${fetchResult.contentType || "(missing)"}: ${item.url}`,
				);
			}

			// Queue/page identity remains the requested item URL. The validated effective URL
			// owns document-base resolution and link-origin classification.
			const processed = await processContent(
				fetchResult.content,
				fetchResult.effectiveUrl,
				fetchResult.contentType,
				this.deps.logger,
				signal,
			);
			signal.throwIfAborted();
			if (processed.type === "failed") {
				return terminal("failure", `[Crawler] Content processing failed: ${item.url}`, "error");
			}
			const processedContent = processed.content;
			if (!hasUsablePageContent(fetchResult.contentType, processedContent.mainContent)) {
				return terminal("failure", `[Crawler] No usable page content: ${item.url}`, "error");
			}

			const normalizedCrawlLinks =
				isHtmlLikeContentType(fetchResult.contentType) && processedContent.links.length
					? this.admissionPolicy.normalizeDiscoveredLinks(
							fetchResult.effectiveUrl,
							processedContent.links,
						)
					: [];
			const pageResult = buildPageResult(options, item, fetchResult, processedContent);

			if (isClientErrorShell(pageResult.pageData.title, pageResult.pageData.mainContent)) {
				return terminal("failure", `[Crawler] Client error shell detected: ${item.url}`, "error");
			}

			if (pageResult.robotsDirectives.noindex) {
				if (!pageResult.robotsDirectives.nofollow) {
					await this.admissionPolicy.admitNormalizedDiscoveredLinks(
						item,
						normalizedCrawlLinks,
						signal,
					);
					signal.throwIfAborted();
				}
				return terminal("skip", `[Robots] noindex: ${item.url}`);
			}

			if (
				isSoft404(
					pageResult.pageData.title,
					pageResult.pageData.mainContent,
					fetchResult.contentLength,
				)
			) {
				return terminal("skip", `[Crawler] Soft 404 skipped: ${item.url}`);
			}

			if (!pageResult.robotsDirectives.nofollow) {
				await this.admissionPolicy.admitNormalizedDiscoveredLinks(
					item,
					normalizedCrawlLinks,
					signal,
				);
			}

			eventSink.log(`[Crawler] Crawled ${item.url}`, "success");
			const chargedDomain = chargedDomainOverride(item, context);
			return {
				terminalOutcome: "success",
				terminalEffects: { chargeDomainBudget: true, ...(chargedDomain ? { chargedDomain } : {}) },
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
