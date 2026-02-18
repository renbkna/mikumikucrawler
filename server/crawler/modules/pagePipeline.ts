import type { Database } from "bun:sqlite";
import sanitizeHtml from "sanitize-html";
import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import { BATCH_CONSTANTS, RETRY_CONSTANTS, SOFT_404_CONSTANTS } from "../../constants.js";
import { ContentProcessor } from "../../processors/ContentProcessor.js";
import type {
	CrawlerSocket,
	ExtractedLink,
	ProcessedContent,
	ProcessedPageData,
	QueueItem,
	SanitizedCrawlOptions,
} from "../../types.js";
import { getErrorMessage, getRobotsRules, normalizeUrl } from "../../utils/helpers.js";
import { updateSessionStats } from "../../utils/sessionPersistence.js";
import type { DynamicRenderer } from "../dynamicRenderer.js";
import type { CrawlQueue } from "./crawlQueue.js";
import type { CrawlState } from "./crawlState.js";
import { fetchContent } from "./fetcher.js";

// ─── Robots directive helpers ─────────────────────────────────────────────────

interface RobotsDirectives {
	noindex: boolean;
	nofollow: boolean;
}

/**
 * Parses a robots directive string (from meta tag or X-Robots-Tag header) into
 * a structured set of flags.
 *
 * Handles comma-separated values and the shorthand `none` (= noindex + nofollow).
 * Agent-specific X-Robots-Tag directives (e.g. "googlebot: noindex") are ignored —
 * we only honour universal directives that apply to all bots.
 */
function parseRobotsDirectives(value: string | null | undefined): RobotsDirectives {
	const result: RobotsDirectives = { noindex: false, nofollow: false };
	if (!value) return result;

	// Filter out agent-specific segments (contain a colon before the directive)
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
 * Merges robots directives from the meta tag and the X-Robots-Tag HTTP header,
 * applying a logical OR so either source can restrict crawl behaviour.
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

// ─── Soft 404 detection ───────────────────────────────────────────────────────

/**
 * Heuristically detects pages that return HTTP 200 but represent an error page
 * ("soft 404"). Checks three signals:
 * 1. Tiny content — server returned almost nothing (< TINY_CONTENT_BYTES).
 * 2. Error title — page title contains known not-found phrases.
 * 3. Short + error keywords — body under SHORT_CONTENT_BYTES and contains keywords.
 */
function isSoft404(
	title: string,
	mainContent: string,
	contentLength: number,
): boolean {
	// Signal 1 — unconditionally tiny response
	if (contentLength > 0 && contentLength < SOFT_404_CONSTANTS.TINY_CONTENT_BYTES) {
		return true;
	}

	const titleLower = title.toLowerCase();
	const keywords = SOFT_404_CONSTANTS.KEYWORDS;

	// Signal 2 — error phrase in title
	if (keywords.some((kw) => titleLower.includes(kw))) {
		return true;
	}

	// Signal 3 — short body containing error keywords
	if (contentLength < SOFT_404_CONSTANTS.SHORT_CONTENT_BYTES) {
		const snippet = mainContent.toLowerCase().slice(0, 1000);
		if (keywords.some((kw) => snippet.includes(kw))) {
			return true;
		}
	}

	return false;
}

const MEDIA_CONTENT_REGEX = /image|video|audio|application\/(pdf|zip)/i;

interface PagePipelineParams {
	options: SanitizedCrawlOptions;
	state: CrawlState;
	logger: Logger;
	socket: CrawlerSocket;
	db: Database;
	dynamicRenderer: DynamicRenderer;
	queue: CrawlQueue;
	targetDomain: string;
	/** Session ID for persisting stats snapshots (resume support). */
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
 * Orchestrates the fetching, processing, and persistence of crawled pages.
 * Returns an async function that processes a single QueueItem.
 */
export function createPagePipeline({
	options,
	state,
	logger,
	socket,
	db,
	dynamicRenderer,
	queue,
	targetDomain,
	sessionId,
}: PagePipelineParams): (item: QueueItem) => Promise<void> {
	const contentProcessor = new ContentProcessor(logger);
	const STATS_THROTTLE_MS = 250;
	let lastStatsEmitTime = 0;

	// Performance optimisation: prepared statements are initialised once and reused
	// for all page saves. bun:sqlite statements are synchronous and safe to cache.
	const insertPageQuery = db.prepare(
		`INSERT INTO pages
		(url, domain, content_type, status_code, data_length, title, description, content, is_dynamic, last_modified, etag,
		 main_content, word_count, reading_time, language, keywords, quality_score, structured_data,
		 media_count, internal_links_count, external_links_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(url) DO UPDATE SET
		  domain = excluded.domain,
		  content_type = excluded.content_type,
		  status_code = excluded.status_code,
		  data_length = excluded.data_length,
		  title = excluded.title,
		  description = excluded.description,
		  content = excluded.content,
		  is_dynamic = excluded.is_dynamic,
		  last_modified = excluded.last_modified,
		  etag = excluded.etag,
		  main_content = excluded.main_content,
		  word_count = excluded.word_count,
		  reading_time = excluded.reading_time,
		  language = excluded.language,
		  keywords = excluded.keywords,
		  quality_score = excluded.quality_score,
		  structured_data = excluded.structured_data,
		  media_count = excluded.media_count,
		  internal_links_count = excluded.internal_links_count,
		  external_links_count = excluded.external_links_count,
		  crawled_at = CURRENT_TIMESTAMP
		RETURNING id`,
	);
	const insertLinkQuery = db.prepare(
		"INSERT OR IGNORE INTO links (source_id, target_url, text) VALUES (?, ?, ?)",
	);

	/**
	 * Creates a processed content object for error cases.
	 */
	const buildFallbackProcessedContent = (
		error: Error | null,
	): ProcessedContent => ({
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
	});

	/**
	 * Constructs a descriptive log message for the crawl result.
	 */
	const buildEnhancedLog = (
		item: QueueItem,
		statusCode: number,
		contentLength: number,
		processedContent: ProcessedContent,
	): string => {
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
	};

	/**
	 * Emits a real-time stats update to the connected client.
	 * Throttled to prevent flooding the socket/client during high-speed crawls.
	 */
	const emitStatsUpdate = (
		log: string,
		processedContent: ProcessedContent,
		item: QueueItem,
	): void => {
		const now = Date.now();
		if (now - lastStatsEmitTime < STATS_THROTTLE_MS) {
			return;
		}
		lastStatsEmitTime = now;

		const currentStats = state.stats;
		socket.emit("stats", {
			...currentStats,
			log,
			lastProcessed: {
				url: item.url,
				wordCount: processedContent.analysis?.wordCount ?? 0,
				qualityScore: processedContent.analysis?.quality?.score ?? 0,
				language: processedContent.analysis?.language || "unknown",
				mediaCount: processedContent.media?.length ?? 0,
				linksCount: processedContent.links?.length ?? 0,
			},
		});

		// Persist stats snapshot to DB so interrupted sessions show real progress
		updateSessionStats(db, sessionId, currentStats);
	};

	/**
	 * Emits a fully processed page to the client.
	 */
	const emitPageToClient = (page: PageRecord): void => {
		socket.emit("pageContent", page);
	};

	interface SaveResultParams {
		item: QueueItem;
		domain: string;
		sanitizedContent: string;
		contentType: string;
		statusCode: number;
		contentLength: number;
		title: string;
		description: string;
		isDynamic: boolean;
		lastModified: string | null;
		etag: string | null;
		processedContent: ProcessedContent;
		links: ExtractedLink[];
	}

	/**
	 * Atomically persists the page record and its discovered links using a
	 * SQLite transaction.  bun:sqlite transactions are synchronous; there is
	 * no async-safe way to impose a wall-clock timeout on them from JavaScript.
	 * If the DB is unusually slow, SQLite's own busy_timeout (set at
	 * database initialisation) provides the low-level guard.
	 *
	 * Performance optimisation: db.transaction() is called once here (not inside
	 * saveCrawlResult) so the returned transaction function is created a single
	 * time and reused for every page save, rather than being re-wrapped on each call.
	 */
	const _saveTransaction = db.transaction(
		(params: SaveResultParams): number | null => {
			const {
				item,
				domain,
				sanitizedContent,
				contentType,
				statusCode,
				contentLength,
				title,
				description,
				isDynamic,
				lastModified,
				etag: pageEtag,
				processedContent,
				links,
			} = params;

			const enhancedData = {
				mainContent: processedContent.extractedData?.mainContent ?? "",
				wordCount: processedContent.analysis?.wordCount ?? 0,
				readingTime: processedContent.analysis?.readingTime ?? 0,
				language: processedContent.analysis?.language ?? "unknown",
				keywords: JSON.stringify(processedContent.analysis?.keywords ?? []),
				qualityScore: processedContent.analysis?.quality?.score ?? 0,
				structuredData: JSON.stringify(processedContent.extractedData ?? {}),
				mediaCount: processedContent.media?.length ?? 0,
				internalLinksCount:
					processedContent.links?.filter(
						(link: ExtractedLink) => link.isInternal,
					)?.length ?? 0,
				externalLinksCount:
					processedContent.links?.filter(
						(link: ExtractedLink) => !link.isInternal,
					)?.length ?? 0,
			};

			const row = insertPageQuery.get(
				item.url,
				domain,
				contentType,
				statusCode,
				contentLength,
				title,
				description,
				options.contentOnly ? null : sanitizedContent,
				isDynamic ? 1 : 0,
				lastModified,
				pageEtag,
				enhancedData.mainContent,
				enhancedData.wordCount,
				enhancedData.readingTime,
				enhancedData.language,
				enhancedData.keywords,
				enhancedData.qualityScore,
				enhancedData.structuredData,
				enhancedData.mediaCount,
				enhancedData.internalLinksCount,
				enhancedData.externalLinksCount,
			) as { id: number } | undefined;

			const pageId = row?.id ?? null;

			if (pageId && links.length > 0) {
				for (const link of links) {
					insertLinkQuery.run(pageId, link.url, link.text ?? "");
				}
			}

			return pageId;
		},
	);

	const saveCrawlResult = (params: SaveResultParams): number | null => {
		try {
			return _saveTransaction(params);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Transaction failed for ${params.item.url}: ${message}`);
			return null;
		}
	};

	/**
	 * Enqueues newly discovered links if they satisfy crawl depth and robots.txt policies.
	 */
	const enqueueLinksWithPolicies = async (
		links: ExtractedLink[],
		item: QueueItem,
		domain: string,
	): Promise<void> => {
		// item.depth is 0-based; only stop enqueueing once we've reached the
		// configured depth limit.  The previous `crawlDepth - 1` guard was
		// off-by-one: with crawlDepth=1 (the minimum) it evaluated 0>=0=true
		// and never enqueued any links at all, even from the root page.
		if (!links.length || item.depth >= options.crawlDepth) {
			return;
		}

		const filteredLinks = links.filter(
			(link: ExtractedLink) =>
				!state.hasVisited(link.url) && !link.nofollow,
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

		await processLinkBatch({
			links: filteredLinks,
			item,
			domain,
			targetDomain,
			options,
			state,
			db,
			logger,
			queue,
		});
	};

	return async function processItem(item: QueueItem): Promise<void> {
		if (!state.canProcessMore()) {
			return;
		}

		if (state.hasVisited(item.url)) {
			return;
		}

		if (!state.isActive) {
			logger.info(`Skipping ${item.url} - session no longer active`);
			return;
		}

		// ── Per-domain budget check ────────────────────────────────────────────
		if (state.isDomainBudgetExceeded(item.domain)) {
			logger.debug(`[Budget] Domain budget exceeded for ${item.domain}, skipping ${item.url}`);
			state.markVisited(item.url);
			state.recordSkip();
			return;
		}

		logger.info(`Fetching: ${item.url}`);

		const fetchStart = Date.now();
		let fetchResult: Awaited<ReturnType<typeof fetchContent>> | undefined;
		try {
			fetchResult = await fetchContent({ item, dynamicRenderer, logger, db });
		} catch (error) {
			state.recordFailure();
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Error fetching ${item.url}: ${message}`);
			socket.emit("stats", {
				...state.stats,
				log: `[Crawler] Error fetching ${item.url}: ${message}`,
			});

			if (item.retries < options.retryLimit && state.isActive) {
				const retries = item.retries + 1;
				const backoffDelay = Math.min(
					RETRY_CONSTANTS.BASE_DELAY * 2 ** retries,
					RETRY_CONSTANTS.MAX_DELAY,
				);
				logger.info(
					`Retrying ${item.url} in ${backoffDelay}ms (attempt ${retries}/${options.retryLimit})`,
				);
				queue.scheduleRetry({ ...item, retries }, backoffDelay);
			}
			return;
		}

		const fetchMs = Date.now() - fetchStart;

		// ── 304 Not Modified ──────────────────────────────────────────────────
		if (fetchResult.unchanged) {
			state.markVisited(item.url);
			state.recordSuccess(0);
			// Touch crawled_at so we know this page was still alive during this crawl
			db.query("UPDATE pages SET crawled_at = CURRENT_TIMESTAMP WHERE url = ?").run(item.url);
			const unchangedLog = `[Crawler] Unchanged: ${item.url} (304)`;
			logger.info(unchangedLog);
			socket.emit("stats", { ...state.stats, log: unchangedLog });

			// Seed queue from cached links so depth traversal continues unchanged
			if (item.depth < options.crawlDepth) {
				const cachedLinks = db
					.query(
						"SELECT target_url FROM links l JOIN pages p ON l.source_id = p.id WHERE p.url = ?",
					)
					.all(item.url) as { target_url: string }[];

				for (const { target_url } of cachedLinks) {
					if (!state.hasVisited(target_url)) {
						queue.enqueue({
							url: target_url,
							depth: item.depth + 1,
							retries: 0,
							parentUrl: item.url,
						});
					}
				}
			}
			return;
		}

		// ── 429 / 503 Rate-limited ────────────────────────────────────────────
		if (fetchResult.rateLimited) {
			// Apply adaptive backoff at the domain level before scheduling retry
			state.adaptDomainDelay(
				item.domain,
				fetchMs,
				fetchResult.statusCode,
				fetchResult.retryAfterMs,
			);
			const retryDelay = fetchResult.retryAfterMs ?? RETRY_CONSTANTS.MAX_DELAY;
			const rateLimitLog = `[Crawler] Rate-limited: ${item.url} — retrying in ${Math.round(retryDelay / 1000)}s`;
			logger.warn(rateLimitLog);
			socket.emit("stats", { ...state.stats, log: rateLimitLog });

			if (item.retries < options.retryLimit && state.isActive) {
				queue.scheduleRetry({ ...item, retries: item.retries + 1 }, retryDelay);
			}
			return;
		}

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

		// ── Adaptive throttle (response-time feedback) ────────────────────────
		state.adaptDomainDelay(item.domain, fetchMs, statusCode);

		state.markVisited(item.url);
		state.recordSuccess(contentLength);

		// domain is pre-parsed at enqueue time — no need to re-parse the URL here.
		const domain = item.domain;

		const sanitizedContent = contentType.includes("text/html")
			? sanitizeHtml(content, {
					allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
					allowedAttributes: {
						...sanitizeHtml.defaults.allowedAttributes,
						// Only allow class/id on safe container elements, not style (XSS risk)
						div: ["class", "id"],
						span: ["class", "id"],
						p: ["class", "id"],
						img: ["class", "id", "src", "alt", "title", "width", "height"],
					},
				})
			: content;

		let processedContent: ProcessedContent;
		try {
			processedContent = await contentProcessor.processContent(
				sanitizedContent,
				item.url,
				contentType,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`ContentProcessor failed for ${item.url}: ${message}`);
			processedContent = buildFallbackProcessedContent(
				error instanceof Error ? error : null,
			);
		}

		// Prepare links for persistence/queueing
		let links: ExtractedLink[] = [];
		if (contentType.includes("text/html") && processedContent.links?.length) {
			// `domain` is already set above from item.domain — reuse it directly.
			links = processedContent.links
				.filter((link) => {
					// Skip non-HTTP protocols
					if (!link.url?.startsWith("http")) return false;
					// Skip external links unless full crawl mode
					if (options.crawlMethod !== "full" && !link.isInternal) return false;
					// Skip file extensions that aren't HTML
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

		if (
			options.saveMedia &&
			(options.crawlMethod === "media" || options.crawlMethod === "full") &&
			MEDIA_CONTENT_REGEX.test(contentType)
		) {
			state.addMedia(1);
		}

		// ── Robots directive enforcement ──────────────────────────────────────
		// Merge meta robots tag and X-Robots-Tag HTTP header (logical OR).
		const robotsDirectives = mergeRobotsDirectives(
			processedContent.metadata?.robots,
			xRobotsTag,
		);

		if (robotsDirectives.noindex) {
			// Page explicitly says "don't index me" — skip the DB write but still
			// log it so the operator can see it happening.
			const noindexLog = `[Robots] noindex: ${item.url} — skipping storage`;
			logger.info(noindexLog);
			socket.emit("stats", { ...state.stats, log: noindexLog });
			state.recordSkip();
			// Still enqueue links unless nofollow is also set
			if (!robotsDirectives.nofollow) {
				await enqueueLinksWithPolicies(links, item, domain);
			}
			return;
		}

		// ── Soft 404 detection ────────────────────────────────────────────────
		if (contentType.includes("text/html")) {
			const mainContent = processedContent.extractedData?.mainContent ?? "";
			if (isSoft404(title, mainContent, contentLength)) {
				const soft404Log = `[Crawler] Soft 404: ${item.url} — skipping storage`;
				logger.info(soft404Log);
				socket.emit("stats", { ...state.stats, log: soft404Log });
				state.recordSkip();
				return;
			}
		}

		// ── Canonical link deduplication ──────────────────────────────────────
		// If this page declares a canonical URL that differs from the URL we
		// fetched, mark the canonical as visited too so we don't crawl the same
		// content under both the variant URL and the canonical URL.
		const rawCanonical = processedContent.metadata?.canonical;
		if (rawCanonical && rawCanonical !== item.url) {
			const normalised = normalizeUrl(rawCanonical);
			if (!("error" in normalised) && normalised.url && normalised.url !== item.url) {
				if (!state.hasVisited(normalised.url)) {
					logger.debug(
						`[Canonical] Marking alias: ${item.url} → ${normalised.url}`,
					);
					state.markVisited(normalised.url);
				}
			}
		}

		// ATOMIC SAVE: Page + Links
		const pageId = saveCrawlResult({
			item,
			domain,
			sanitizedContent,
			contentType,
			statusCode,
			contentLength,
			title,
			description,
			isDynamic,
			lastModified,
			etag,
			processedContent,
			links,
		});

		const logMessage = buildEnhancedLog(
			item,
			statusCode,
			contentLength,
			processedContent,
		);
		// Also write to server log so the terminal shows crawl progress.
		// Without this, "Fetching: ..." is the last visible line for every successful
		// page, which looks identical to a hang.
		logger.info(logMessage);
		emitStatsUpdate(logMessage, processedContent, item);

		// Increment per-domain counter after a successful save
		state.recordDomainPage(domain);

		emitPageToClient({
			id: pageId,
			url: item.url,
			title,
			description,
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
		});

		// nofollow: store the page content but don't traverse its outbound links
		if (!robotsDirectives.nofollow) {
			await enqueueLinksWithPolicies(links, item, domain);
		} else {
			logger.debug(`[Robots] nofollow: ${item.url} — not enqueueing links`);
		}
	};
}

interface ProcessLinkBatchOptions {
	links: ExtractedLink[];
	item: QueueItem;
	domain: string;
	targetDomain: string;
	options: SanitizedCrawlOptions;
	state: CrawlState;
	db: Database;
	logger: Logger;
	queue: CrawlQueue;
}

/**
 * Processes a batch of links concurrently while respecting robots.txt rules and domain delays.
 *
 * NOTE: We use a limited concurrency model (ProcessLinkBatchOptions.CONCURRENCY) here
 * rather than blasting all links at once to avoid:
 * 1. Overwhelming the robots.txt parser/cache.
 * 2. Spiking event loop lag with thousands of microtasks.
 */
async function processLinkBatch({
	links,
	item,
	domain,
	targetDomain,
	options,
	state,
	db,
	logger,
	queue,
}: ProcessLinkBatchOptions): Promise<void> {
	const CONCURRENCY = BATCH_CONSTANTS.LINK_BATCH_CONCURRENCY;

	const processSingleLink = async (link: ExtractedLink): Promise<void> => {
		// Bail out immediately if the session was stopped while batch is running
		if (!state.isActive) return;
		try {
			const linkUrl = new URL(link.url);
			const linkDomain = linkUrl.hostname;

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
			const message = getErrorMessage(err);
			logger.debug(`Error processing link ${link.url}: ${message}`);
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
