import type { Database } from "bun:sqlite";
import sanitizeHtml from "sanitize-html";
import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import { BATCH_CONSTANTS, RETRY_CONSTANTS } from "../../constants.js";
import { ContentProcessor } from "../../processors/ContentProcessor.js";
import type {
	CrawlerSocket,
	ExtractedLink,
	ProcessedContent,
	ProcessedPageData,
	QueueItem,
	SanitizedCrawlOptions,
} from "../../types.js";
import { getErrorMessage, getRobotsRules } from "../../utils/helpers.js";
import type { DynamicRenderer } from "../dynamicRenderer.js";
import type { CrawlQueue } from "./crawlQueue.js";
import type { CrawlState } from "./crawlState.js";
import { fetchContent } from "./fetcher.js";

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
}: PagePipelineParams): (item: QueueItem) => Promise<void> {
	const contentProcessor = new ContentProcessor(logger);
	const STATS_THROTTLE_MS = 250;
	let lastStatsEmitTime = 0;

	// Performance optimisation: prepared statements are initialised once and reused
	// for all page saves. bun:sqlite statements are synchronous and safe to cache.
	const insertPageQuery = db.prepare(
		`INSERT INTO pages
		(url, domain, content_type, status_code, data_length, title, description, content, is_dynamic, last_modified,
		 main_content, word_count, reading_time, language, keywords, quality_score, structured_data,
		 media_count, internal_links_count, external_links_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

		socket.emit("stats", {
			...state.stats,
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
			(link: ExtractedLink) => !state.hasVisited(link.url),
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

		logger.info(`Fetching: ${item.url}`);

		let fetchResult: Awaited<ReturnType<typeof fetchContent>> | undefined;
		try {
			fetchResult = await fetchContent({ item, dynamicRenderer, logger });
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

		const {
			content,
			statusCode,
			contentType,
			contentLength,
			title,
			description,
			lastModified,
			isDynamic,
		} = fetchResult;

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

		await enqueueLinksWithPolicies(links, item, domain);
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
