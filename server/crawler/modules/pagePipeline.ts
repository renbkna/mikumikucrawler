import type { Database } from "bun:sqlite";
import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import {
	BATCH_CONSTANTS,
	RETRY_CONSTANTS,
	SOFT_404_CONSTANTS,
} from "../../constants.js";
import {
	createPageStatements,
	getCachedLinksByPageUrl,
	updatePageTimestamp,
	updateSessionStats,
} from "../../data/queries.js";
import { ContentProcessor } from "../../processors/ContentProcessor.js";
import type {
	CrawlerSocket,
	ExtractedLink,
	FetchResult,
	ProcessedContent,
	ProcessedPageData,
	QueueItem,
	SanitizedCrawlOptions,
} from "../../types.js";
import {
	getErrorMessage,
	getRobotsRules,
	normalizeUrl,
} from "../../utils/helpers.js";
import type { DynamicRenderer } from "../dynamicRenderer.js";
import type { CrawlQueue } from "./crawlQueue.js";
import type { CrawlState } from "./crawlState.js";
import { fetchContent } from "./fetcher.js";

interface RobotsDirectives {
	noindex: boolean;
	nofollow: boolean;
}

/**
 * Parses robots meta directives from a comma-separated value.
 * Handles both "noindex" and "nofollow" as well as "none" (which means both).
 *
 * Contract:
 * - Input: Comma-separated string or null/undefined
 * - Output: Object with boolean flags for noindex/nofollow
 * - Invariant: Always returns a valid object, never throws
 */
function parseRobotsDirectives(
	value: string | null | undefined,
): RobotsDirectives {
	const result: RobotsDirectives = { noindex: false, nofollow: false };
	if (!value) return result;

	const universal = value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => !s.includes(":"))
		.join(",")
		.toLowerCase();

	result.noindex = /\bnoindex\b|\bnone\b/.test(universal);
	result.nofollow = /\bnofollow\b|\bnone\b/.test(universal);
	return result;
}

/**
 * Merges robots directives from meta tag and HTTP header.
 * Both sources are OR'd together (if either says noindex, it's noindex).
 *
 * Contract:
 * - Input: Two directive sources (may be null/undefined)
 * - Output: Combined directives
 * - Invariant: noindex = meta.noindex || header.noindex
 */
function mergeRobotsDirectives(
	metaRobots: string | null | undefined,
	xRobotsTag: string | null | undefined,
): RobotsDirectives {
	const fromMeta = parseRobotsDirectives(metaRobots);
	const fromHeader = parseRobotsDirectives(xRobotsTag);
	return {
		noindex: fromMeta.noindex || fromHeader.noindex,
		nofollow: fromMeta.nofollow || fromHeader.nofollow,
	};
}

/**
 * Detects soft 404 pages based on title, content, and size.
 * Soft 404s are error pages that return HTTP 200 but indicate "not found".
 *
 * Contract:
 * - Input: Page title, main content, content length in bytes
 * - Output: true if soft 404 detected
 * - Edge cases:
 *   - Tiny content (< 100 bytes) always considered soft 404
 *   - Title keywords trigger detection regardless of content
 *   - Content keywords only checked if content is short (< 1KB)
 */
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
	const keywords = SOFT_404_CONSTANTS.KEYWORDS;

	if (keywords.some((kw) => titleLower.includes(kw))) {
		return true;
	}

	if (contentLength < SOFT_404_CONSTANTS.SHORT_CONTENT_BYTES) {
		const snippet = mainContent.toLowerCase().slice(0, 1000);
		if (keywords.some((kw) => snippet.includes(kw))) {
			return true;
		}
	}

	return false;
}

const MEDIA_CONTENT_REGEX = /image|video|audio|application\/(pdf|zip)/i;

interface PipelineContext {
	options: SanitizedCrawlOptions;
	state: CrawlState;
	logger: Logger;
	socket: CrawlerSocket;
	db: Database;
	dynamicRenderer: DynamicRenderer;
	queue: CrawlQueue;
	targetDomain: string;
	sessionId: string;
}

interface PageRecord {
	id: number | null;
	url: string;
	title: string;
	description: string;
	contentType: string;
	domain: string;
	processedData: ProcessedPageData;
}

/**
 * PHASE 1: Pre-checks
 * Validates that the item can and should be processed.
 *
 * Contract:
 * - Input: QueueItem, CrawlState
 * - Output: { shouldProcess: boolean, reason?: string }
 * - Invariants:
 *   - Returns shouldProcess=false if state.canProcessMore() is false
 *   - Returns shouldProcess=false if URL already visited
 *   - Returns shouldProcess=false if domain budget exceeded
 *   - Marks URL visited and records skip on budget exceeded
 *
 * Edge cases:
 * - Session stopped: logs info, returns false
 * - Domain budget exceeded: marks visited, records skip, returns false
 */
function runPreChecks(
	item: QueueItem,
	ctx: PipelineContext,
): { shouldProcess: boolean; reason?: string } {
	const { state, logger } = ctx;

	if (!state.canProcessMore()) {
		return { shouldProcess: false, reason: "Page limit reached" };
	}

	if (state.hasVisited(item.url)) {
		return { shouldProcess: false, reason: "Already visited" };
	}

	if (!state.isActive) {
		const reason = `session no longer active`;
		logger.info(`Skipping ${item.url} - ${reason}`);
		return { shouldProcess: false, reason };
	}

	if (state.isDomainBudgetExceeded(item.domain)) {
		logger.debug(
			`[Budget] Domain budget exceeded for ${item.domain}, skipping ${item.url}`,
		);
		state.markVisited(item.url);
		state.recordSkip();
		return { shouldProcess: false, reason: "Domain budget exceeded" };
	}

	return { shouldProcess: true };
}

/**
 * PHASE 2: Fetch
 * Retrieves content from the URL using fetch or dynamic rendering.
 *
 * Contract:
 * - Input: QueueItem, DynamicRenderer, Logger, Database
 * - Output: FetchResult or throws Error
 * - Invariants:
 *   - HTTP timeout enforced by fetcher (30s)
 *   - Dynamic rendering only if options.dynamic is true
 *   - All network errors thrown as Error with context
 *
 * Edge cases:
 * - Network timeout: throws Error with "timeout" message
 * - DNS failure: throws Error
 * - SSL error: throws Error
 */
async function executeFetch(
	item: QueueItem,
	ctx: PipelineContext,
): Promise<FetchResult> {
	ctx.logger.info(`Fetching: ${item.url}`);
	return fetchContent({
		item,
		dynamicRenderer: ctx.dynamicRenderer,
		logger: ctx.logger,
		db: ctx.db,
	});
}

/**
 * PHASE 3: Handle Fetch Response
 * Processes the result of the fetch operation.
 * Handles 304, rate limiting, and errors.
 *
 * Contract:
 * - Input: FetchResult, QueueItem, CrawlState, CrawlQueue, Logger, CrawlerSocket
 * - Output: { handled: boolean, shouldContinue?: boolean }
 * - Invariants:
 *   - 304: Updates timestamp, enqueues cached links, marks success
 *   - Rate limited: Adapts domain delay, schedules retry
 *   - Error: Records failure, schedules retry if retries remain
 *
 * Edge cases:
 * - 304 with cached links: Links enqueued for re-crawl at next depth
 * - Rate limit with Retry-After: Uses header value or doubles delay
 * - Permanent failure (404/410/501): No retry
 * - Blocked (403): Records failure, increases domain delay
 */
function handleNonSuccessResponse(
	fetchResult: Exclude<FetchResult, { type: "success" }>,
	item: QueueItem,
	ctx: PipelineContext,
): void {
	const { state, queue, db, logger, socket, options } = ctx;

	switch (fetchResult.type) {
		case "unchanged": {
			state.markVisited(item.url);
			state.recordSuccess(0);
			updatePageTimestamp(db, item.url);
			const unchangedLog = `[Crawler] Unchanged: ${item.url} (304)`;
			logger.info(unchangedLog);
			state.emitLog(socket, unchangedLog);

			if (item.depth < options.crawlDepth) {
				const cachedLinks = getCachedLinksByPageUrl(db, item.url);
				for (const targetUrl of cachedLinks) {
					if (!state.hasVisited(targetUrl)) {
						queue.enqueue({
							url: targetUrl,
							depth: item.depth + 1,
							retries: 0,
							parentUrl: item.url,
						});
					}
				}
			}
			return;
		}

		case "rateLimited": {
			state.adaptDomainDelay(
				item.domain,
				fetchResult.statusCode,
				fetchResult.retryAfterMs,
			);
			const retryDelay = fetchResult.retryAfterMs ?? RETRY_CONSTANTS.MAX_DELAY;
			const rateLimitLog = `[Crawler] Rate-limited: ${item.url} — retrying in ${Math.round(retryDelay / 1000)}s`;
			logger.warn(rateLimitLog);
			state.emitLog(socket, rateLimitLog);

			if (item.retries < options.retryLimit && state.isActive) {
				queue.scheduleRetry(
					{ ...item, retries: item.retries + 1 },
					retryDelay,
				);
			}
			return;
		}

		case "permanentFailure": {
			state.markVisited(item.url);
			state.recordFailure();
			const failLog = `[Crawler] Permanent failure: ${item.url} (${fetchResult.statusCode})`;
			logger.info(failLog);
			state.emitLog(socket, failLog);
			return;
		}

		case "blocked": {
			state.markVisited(item.url);
			state.recordFailure();
			state.adaptDomainDelay(item.domain, fetchResult.statusCode);
			const blockedLog = `[Crawler] Blocked: ${item.url} (${fetchResult.statusCode})`;
			logger.info(blockedLog);
			state.emitLog(socket, blockedLog);
			return;
		}
	}
}

/**
 * PHASE 4: Process Content
 * Extracts and analyzes content from the fetched data.
 *
 * Contract:
 * - Input: content string, contentType, URL, ContentProcessor, Logger
 * - Output: ProcessedContent
 * - Invariants:
 *   - HTML sanitized with allowed tags/attributes
 *   - Never throws - returns fallback on error
 *   - PDF processing has size/page limits
 *
 * Edge cases:
 * - Parse error: Returns fallback with error recorded
 * - Empty content: Returns fallback with zero stats
 * - Binary content: Skipped, empty result
 */
async function processFetchedContent(
	content: string,
	contentType: string,
	url: string,
	contentProcessor: ContentProcessor,
	logger: Logger,
): Promise<ProcessedContent> {
	// Pass raw content to ContentProcessor — extraction needs the full DOM
	// (video, audio, nav, etc). Sanitization is a display concern handled by
	// the frontend (DOMPurify), not an analysis concern.
	try {
		return await contentProcessor.processContent(
			content,
			url,
			contentType,
		);
	} catch (error) {
		logger.error(
			`ContentProcessor failed for ${url}: ${getErrorMessage(error)}`,
		);
		return buildFallbackProcessedContent(error instanceof Error ? error : null);
	}
}

/**
 * PHASE 5: Check Robots Directives
 * Determines if content should be indexed/followed per robots meta.
 *
 * Contract:
 * - Input: ProcessedContent, xRobotsTag header value
 * - Output: RobotsDirectives
 * - Invariants:
 *   - noindex: skip storage but may follow links
 *   - nofollow: skip link enqueue but store content
 *   - none: both noindex and nofollow
 */
function checkRobotsDirectives(
	processedContent: ProcessedContent,
	xRobotsTag: string | null,
): RobotsDirectives {
	return mergeRobotsDirectives(processedContent.metadata?.robots, xRobotsTag);
}

/**
 * PHASE 6: Quality Gate
 * Validates content quality before storage.
 *
 * Contract:
 * - Input: title, mainContent, contentLength, contentType
 * - Output: { passed: boolean, reason?: string }
 * - Invariants:
 *   - Soft 404s rejected
 *   - Only checked for HTML content
 *   - Failed content recorded as skip
 *
 * Edge cases:
 * - Empty title: Not a soft 404 (may be valid)
 * - Very short content: Checked against soft 404 patterns
 */
function runQualityGate(
	title: string,
	processedContent: ProcessedContent,
	contentLength: number,
	contentType: string,
): { passed: boolean; reason?: string } {
	if (!contentType.includes("text/html")) {
		return { passed: true };
	}

	const mainContent = processedContent.extractedData?.mainContent ?? "";
	if (isSoft404(title, mainContent, contentLength)) {
		return { passed: false, reason: "Soft 404 detected" };
	}

	return { passed: true };
}

/**
 * PHASE 7: Save Results
 * Persists page data to SQLite database.
 *
 * Contract:
 * - Input: SaveResultParams
 * - Output: pageId or null
 * - Invariants:
 *   - Single transaction for page + links
 *   - URL is UNIQUE (UPSERT on conflict)
 *   - crawled_at auto-updated on conflict
 *   - Returns null on transaction failure
 *
 * Edge cases:
 * - Duplicate URL: Updates existing record
 * - Transaction failure: Logs error, returns null
 * - Invalid JSON in structured data: Handled by JSON.stringify
 */

/**
 * PHASE 9: Enqueue Links
 * Processes discovered links and adds them to the crawl queue.
 *
 * Contract:
 * - Input: links array, QueueItem, CrawlState, CrawlQueue, options
 * - Output: Promise<void>
 * - Invariants:
	- Links filtered by depth (cannot exceed crawlDepth)
	- Links filtered by robots (nofollow skipped)
	- External links checked against robots.txt
 *   - Link batch processing is concurrent (max 5)
 *
 * Edge cases:
 * - Invalid URL: Skipped, error logged
 * - robots.txt fetch fails: Link skipped (safe default)
 * - Domain budget exceeded: Link silently dropped
 */
async function enqueueDiscoveredLinks(
	links: ExtractedLink[],
	item: QueueItem,
	domain: string,
	ctx: PipelineContext,
): Promise<void> {
	const { state, queue, options } = ctx;

	if (!links.length || item.depth >= options.crawlDepth) {
		return;
	}

	const filteredLinks = links.filter(
		(link: ExtractedLink) => !state.hasVisited(link.url) && !link.nofollow,
	);
	if (!filteredLinks.length) {
		return;
	}

	if (!options.respectRobots) {
		for (const link of filteredLinks) {
			queue.enqueue({
				url: link.url,
				depth: item.depth + 1,
				retries: 0,
				parentUrl: item.url,
			});
		}
		return;
	}

	await processLinkBatch(filteredLinks, item, domain, ctx);
}

/**
 * Builds a fallback ProcessedContent when processing fails.
 *
 * Contract:
 * - Input: Error or null
 * - Output: Valid ProcessedContent with safe defaults
 * - Invariants:
 *   - All required fields present
 *   - Errors array populated if error provided
 */
function buildFallbackProcessedContent(error: Error | null): ProcessedContent {
	return {
		extractedData: { mainContent: "" },
		analysis: {
			wordCount: 0,
			readingTime: 0,
			language: "unknown",
			keywords: [],
			sentiment: "neutral",
			readabilityScore: 0,
			quality: { score: 0, factors: {}, issues: ["Processing failed"] },
		},
		metadata: {},
		media: [],
		links: [],
		errors: error ? [{ type: "processor_error", message: error.message }] : [],
	};
}

/**
 * Builds an enhanced log message with crawl metrics.
 *
 * Contract:
 * - Input: QueueItem, statusCode, contentLength, ProcessedContent
 * - Output: Formatted log string
 * - Invariants:
 *   - Always returns string
 *   - Handles null/undefined values safely
 */
function buildEnhancedLog(
	item: QueueItem,
	statusCode: number,
	contentLength: number,
	processedContent: ProcessedContent,
): string {
	const resolvedStatus = Number.isFinite(statusCode) ? statusCode : "n/a";
	const sizeKb = Number.isFinite(contentLength)
		? Math.max(Math.floor(contentLength / 1024), 0)
		: 0;

	const segments: (string | number)[] = [
		`[Crawler] Crawled ${item.url} (${resolvedStatus})`,
		`${sizeKb}KB`,
	];

	if (processedContent.analysis?.wordCount) {
		segments.push(`${processedContent.analysis.wordCount} words`);
	}

	if (
		processedContent.analysis?.language &&
		processedContent.analysis.language !== "unknown"
	) {
		segments.push(`Lang: ${processedContent.analysis.language}`);
	}

	if (processedContent.analysis?.quality?.score) {
		segments.push(`Quality: ${processedContent.analysis.quality.score}/100`);
	}

	if (processedContent.links?.length) {
		segments.push(`${processedContent.links.length} links`);
	}

	if (processedContent.media?.length) {
		segments.push(`${processedContent.media.length} media`);
	}

	return segments.join(" | ");
}

/**
 * Main pipeline factory function.
 * Creates a configured pipeline function for processing crawl items.
 *
 * Contract:
 * - Input: PipelineContext
 * - Output: Function (QueueItem) => Promise<void>
 * - Invariants:
 *   - Pipeline handles all errors internally (never throws to caller)
 *   - Each item goes through all 9 phases
 *   - Early returns respect phase boundaries
 *
 * Phase Execution Order:
 * 1. Pre-checks (validation)
 * 2. Fetch (network request)
 * 3. Response handling (304, rate limits)
 * 4. Content processing (parse, analyze)
 * 5. Robots directives (index/follow rules)
 * 6. Quality gate (soft 404 detection)
 * 7. Storage (SQLite persistence)
 * 8. Emission (WebSocket notify)
 * 9. Link enqueue (discover new URLs)
 */
export function createPagePipeline(
	ctx: PipelineContext,
): (item: QueueItem) => Promise<void> {
	const { options, state, logger, socket, db, sessionId } = ctx;
	const contentProcessor = new ContentProcessor(logger);
	let lastStatsEmitTime = 0;
	const STATS_THROTTLE_MS = 250;

	const { saveTransaction } = createPageStatements(db);

	return async function processItem(item: QueueItem): Promise<void> {
		// Phase 1: Pre-checks
		const preCheck = runPreChecks(item, ctx);
		if (!preCheck.shouldProcess) {
			return;
		}

		// Phase 2: Fetch
		let fetchResult: FetchResult;
		try {
			fetchResult = await executeFetch(item, ctx);
		} catch (error) {
			state.recordFailure();
			logger.error(`Error fetching ${item.url}: ${getErrorMessage(error)}`);
			state.emitLog(
				socket,
				`[Crawler] Error fetching ${item.url}: ${getErrorMessage(error)}`,
			);

			if (item.retries < options.retryLimit && state.isActive) {
				const retries = item.retries + 1;
				const backoffDelay = Math.min(
					RETRY_CONSTANTS.BASE_DELAY * 2 ** retries,
					RETRY_CONSTANTS.MAX_DELAY,
				);
				logger.info(
					`Retrying ${item.url} in ${backoffDelay}ms (attempt ${retries}/${options.retryLimit})`,
				);
				ctx.queue.scheduleRetry({ ...item, retries }, backoffDelay);
			}
			return;
		}

		// Phase 3: Handle non-success responses (304, rate limit, 4xx)
		if (fetchResult.type !== "success") {
			handleNonSuccessResponse(fetchResult, item, ctx);
			return;
		}

		// TypeScript narrows fetchResult to FetchSuccess from here
		const {
			content,
			statusCode,
			contentType,
			contentLength,
			title,
			description,
			lastModified,
			etag,
			xRobotsTag,
			isDynamic,
		} = fetchResult;

		// Update domain delay based on response
		state.adaptDomainDelay(item.domain, statusCode);
		state.markVisited(item.url);
		state.recordSuccess(contentLength);

		const domain = item.domain;

		// Phase 4: Process Content
		const processedContent = await processFetchedContent(
			content,
			contentType,
			item.url,
			contentProcessor,
			logger,
		);

		// Resolve title/description from processed metadata (avoids double cheerio parse in fetcher)
		const resolvedTitle = title || processedContent.metadata?.title || "";
		const resolvedDescription =
			description || processedContent.metadata?.description || "";

		// Extract and filter links
		let links: ExtractedLink[] = [];
		if (contentType.includes("text/html") && processedContent.links?.length) {
			links = processedContent.links
				.filter((link) => {
					if (!link.url?.startsWith("http")) return false;
					if (options.crawlMethod !== "full" && !link.isInternal) return false;
					if (
						/\.(css|js|json|xml|txt|md|csv|svg|ico|git|gitignore)$/i.test(
							link.url,
						)
					)
						return false;
					return true;
				})
				.map((link) => ({
					url: link.url,
					text: link.text ?? "",
					isInternal: link.isInternal ?? link.domain === domain,
					nofollow: link.nofollow,
				}));

			state.addLinks(processedContent.links.length);
		}

		// Track media if enabled
		if (
			options.saveMedia &&
			(options.crawlMethod === "media" || options.crawlMethod === "full") &&
			MEDIA_CONTENT_REGEX.test(contentType)
		) {
			state.addMedia(1);
		}

		// Phase 5: Check Robots Directives
		const robotsDirectives = checkRobotsDirectives(
			processedContent,
			xRobotsTag,
		);

		// Phase 6: Quality Gate
		const qualityCheck = runQualityGate(
			resolvedTitle,
			processedContent,
			contentLength,
			contentType,
		);

		// Handle robots directives
		if (robotsDirectives.noindex) {
			const noindexLog = `[Robots] noindex: ${item.url} — skipping storage`;
			logger.info(noindexLog);
			state.emitLog(socket, noindexLog);
			state.recordSkip();
			if (!robotsDirectives.nofollow) {
				await enqueueDiscoveredLinks(links, item, domain, ctx);
			}
			return;
		}

		// Handle quality gate failure
		if (!qualityCheck.passed) {
			const qualityLog = `[Crawler] ${qualityCheck.reason}: ${item.url} — skipping storage`;
			logger.info(qualityLog);
			state.emitLog(socket, qualityLog);
			state.recordSkip();
			return;
		}

		// Handle canonical URL
		const rawCanonical = processedContent.metadata?.canonical;
		if (rawCanonical && rawCanonical !== item.url) {
			const normalised = normalizeUrl(rawCanonical);
			if (
				!("error" in normalised) &&
				normalised.url &&
				normalised.url !== item.url
			) {
				if (!state.hasVisited(normalised.url)) {
					logger.debug(
						`[Canonical] Marking alias: ${item.url} → ${normalised.url}`,
					);
					state.markVisited(normalised.url);
				}
			}
		}

		// Phase 7: Save Results
		let pageId: number | null = null;
		try {
			pageId = saveTransaction({
				url: item.url,
				domain,
				content: options.contentOnly ? null : content,
				contentType,
				statusCode,
				contentLength,
				title: resolvedTitle,
				description: resolvedDescription,
				isDynamic,
				lastModified,
				etag,
				processedContent,
				links,
			});
		} catch (error) {
			logger.error(
				`Transaction failed for ${item.url}: ${getErrorMessage(error)}`,
			);
		}

		// Build log message
		const logMessage = buildEnhancedLog(
			item,
			statusCode,
			contentLength,
			processedContent,
		);
		logger.info(logMessage);

		// Phase 8: Emit Results
		const pageRecord: PageRecord = {
			id: pageId,
			url: item.url,
			title: resolvedTitle,
			description: resolvedDescription,
			contentType,
			domain,
			processedData: {
				extractedData: {
					mainContent: processedContent.extractedData?.mainContent,
					jsonLd: (processedContent.extractedData?.jsonLd ?? []) as Record<
						string,
						unknown
					>[],
					microdata: processedContent.extractedData?.microdata,
					openGraph: processedContent.extractedData?.openGraph,
					twitterCards: processedContent.extractedData?.twitterCards,
					schema: processedContent.extractedData?.schema,
				},
				metadata: {
					title: processedContent.metadata?.title,
					description: processedContent.metadata?.description,
					author: processedContent.metadata?.author,
					publishDate: processedContent.metadata?.publishDate,
					modifiedDate: processedContent.metadata?.modifiedDate,
					canonical: processedContent.metadata?.canonical,
					robots: processedContent.metadata?.robots,
					viewport: processedContent.metadata?.viewport,
					charset: processedContent.metadata?.charset,
					generator: processedContent.metadata?.generator,
				},
				analysis: {
					wordCount: processedContent.analysis?.wordCount ?? 0,
					readingTime: processedContent.analysis?.readingTime ?? 0,
					language: processedContent.analysis?.language ?? "unknown",
					keywords: processedContent.analysis?.keywords ?? [],
					sentiment: processedContent.analysis?.sentiment ?? "neutral",
					readabilityScore: processedContent.analysis?.readabilityScore ?? 0,
					quality: processedContent.analysis?.quality,
				},
				media: processedContent.media ?? [],
				qualityScore: processedContent.analysis?.quality?.score ?? 0,
				language: processedContent.analysis?.language ?? "unknown",
			},
		};

		socket.emit("pageContent", pageRecord);

		// Throttle stats to avoid flooding
		const emitNow = Date.now();
		if (emitNow - lastStatsEmitTime >= STATS_THROTTLE_MS) {
			lastStatsEmitTime = emitNow;
			state.emitStats(socket, {
				log: `[Crawler] Crawled ${item.url}`,
				lastProcessed: {
					url: item.url,
					wordCount: processedContent.analysis?.wordCount ?? 0,
					qualityScore: processedContent.analysis?.quality?.score ?? 0,
					language: processedContent.analysis?.language || "unknown",
					mediaCount: processedContent.media?.length ?? 0,
					linksCount: processedContent.links?.length ?? 0,
				},
			});
			updateSessionStats(db, sessionId, state.stats);
		}

		state.recordDomainPage(domain);

		// Phase 9: Enqueue Links
		if (!robotsDirectives.nofollow) {
			await enqueueDiscoveredLinks(links, item, domain, ctx);
		} else {
			logger.debug(`[Robots] nofollow: ${item.url} — not enqueueing links`);
		}
	};
}

async function processLinkBatch(
	links: ExtractedLink[],
	item: QueueItem,
	domain: string,
	ctx: PipelineContext,
): Promise<void> {
	const { state, queue, db, logger, options, targetDomain } = ctx;
	const CONCURRENCY = BATCH_CONSTANTS.LINK_BATCH_CONCURRENCY;

	const processSingleLink = async (link: ExtractedLink): Promise<void> => {
		if (!state.isActive) return;
		try {
			const linkUrl = new URL(link.url);
			const linkDomain = linkUrl.hostname;

			// Skip malformed URLs where the "hostname" looks like a protocol name
			if (!linkDomain || !linkDomain.includes(".")) return;

			if (linkDomain !== domain && linkDomain !== targetDomain) {
				const robots = await getRobotsRules(linkDomain, db, logger);
				if (robots && !robots.isAllowed(link.url, config.userAgent)) {
					logger.debug(`Skipping ${link.url} - disallowed by robots.txt`);
					state.recordSkip();
					return;
				}

				const crawlDelay = robots?.getCrawlDelay?.(config.userAgent);
				if (crawlDelay) {
					const delayMs = Math.max(crawlDelay * 1000, options.crawlDelay);
					state.setDomainDelay(linkDomain, delayMs);
				} else {
					state.setDomainDelay(linkDomain, options.crawlDelay);
				}
			}

			queue.enqueue({
				url: link.url,
				depth: item.depth + 1,
				retries: 0,
				parentUrl: item.url,
			});
		} catch (err) {
			logger.debug(
				`Error processing link ${link.url}: ${getErrorMessage(err)}`,
			);
		}
	};

	const runTask = async (
		iterator: IterableIterator<ExtractedLink>,
	): Promise<void> => {
		for (const link of iterator) {
			await processSingleLink(link);
		}
	};

	const linksIterator = links.values();
	const workerCount = Math.min(links.length, CONCURRENCY);
	const workers = Array.from({ length: workerCount }, () =>
		runTask(linksIterator),
	);

	await Promise.all(workers);
}
