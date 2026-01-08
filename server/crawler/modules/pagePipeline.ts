import type { Database } from "bun:sqlite";
import { URL } from "node:url";
import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import { FETCH_HEADERS } from "../../constants.js";
import { ContentProcessor } from "../../processors/ContentProcessor.js";
import type {
	CrawlerSocket,
	ExtractedLink,
	ProcessedContent,
	ProcessedPageData,
	QueueItem,
	SanitizedCrawlOptions,
} from "../../types.js";
import { extractMetadata, getRobotsRules } from "../../utils/helpers.js";
import type { DynamicRenderer } from "../dynamicRenderer.js";
import type { CrawlQueue } from "./crawlQueue.js";
import type { CrawlState } from "./crawlState.js";

const MEDIA_CONTENT_REGEX = /image|video|audio|application\/(pdf|zip)/i;

interface PagePipelineParams {
	options: SanitizedCrawlOptions;
	state: CrawlState;
	logger: Logger;
	socket: CrawlerSocket;
	dbPromise: Promise<Database>;
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
	dbPromise,
	dynamicRenderer,
	queue,
	targetDomain,
}: PagePipelineParams): (item: QueueItem) => Promise<void> {
	const contentProcessor = new ContentProcessor(logger);

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

		return segments.filter(Boolean).join(" | ");
	};

	/**
	 * Emits a real-time stats update to the connected client.
	 */
	const emitStatsUpdate = (
		log: string,
		processedContent: ProcessedContent,
		item: QueueItem,
	): void => {
		socket.emit("stats", {
			...state.stats,
			log,
			lastProcessed: {
				url: item.url,
				wordCount: processedContent.analysis?.wordCount || 0,
				qualityScore: processedContent.analysis?.quality?.score || 0,
				language: processedContent.analysis?.language || "unknown",
				mediaCount: processedContent.media?.length || 0,
				linksCount: processedContent.links?.length || 0,
			},
		});
	};

	/**
	 * Emits a fully processed page to the client.
	 */
	const emitPageToClient = (page: PageRecord): void => {
		socket.emit("pageContent", page);
	};

	/**
	 * Fetches content from a URL using dynamic renderer if enabled, otherwise falls back to static fetch.
	 */
	const fetchContent = async (item: QueueItem) => {
		let content = "";
		let contentType = "";
		let statusCode = 0;
		let contentLength = 0;
		let title = "";
		let description = "";
		let lastModified: string | null = null;
		let isDynamic = false;

		const dynamicResult = dynamicRenderer.isEnabled()
			? await dynamicRenderer.render(item)
			: null;

		if (dynamicResult) {
			content = dynamicResult.content;
			statusCode = dynamicResult.statusCode;
			contentType = dynamicResult.contentType;
			contentLength = dynamicResult.contentLength;
			title = dynamicResult.title;
			description = dynamicResult.description;
			lastModified = dynamicResult.lastModified ?? null;
			isDynamic = true;
		}

		if (!content) {
			logger.info(`Using static crawling for ${item.url}`);
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 15000);

			try {
				const response = await fetch(item.url, {
					headers: FETCH_HEADERS,
					signal: controller.signal,
					redirect: "follow",
				});
				clearTimeout(timeoutId);

				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}

				content = await response.text();
				statusCode = response.status;
				contentType = response.headers.get("content-type") || "";
				contentLength = Number.parseInt(
					response.headers.get("content-length") || "0",
					10,
				);
				lastModified = response.headers.get("last-modified") ?? null;
			} catch (error) {
				clearTimeout(timeoutId);
				throw error;
			}
		}

		if (contentType.includes("text/html") && (!title || !description)) {
			const $ = cheerio.load(content);
			const metadata = extractMetadata($);
			if (!title) {
				title = metadata.title;
			}
			if (!description) {
				description = metadata.description;
			}
		}

		if (!contentLength && content) {
			contentLength = Buffer.byteLength(content, "utf8");
		}

		return {
			content,
			statusCode,
			contentType,
			contentLength,
			title,
			description,
			lastModified,
			isDynamic,
		};
	};

	interface StorePageRecordParams {
		db: Database;
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
	}

	/**
	 * Persists a crawled page and its analysis to the database.
	 */
	const storePageRecord = ({
		db,
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
	}: StorePageRecordParams): number | null => {
		const enhancedData = {
			mainContent: processedContent.extractedData?.mainContent || "",
			wordCount: processedContent.analysis?.wordCount || 0,
			readingTime: processedContent.analysis?.readingTime || 0,
			language: processedContent.analysis?.language || "unknown",
			keywords: JSON.stringify(processedContent.analysis?.keywords || []),
			qualityScore: processedContent.analysis?.quality?.score || 0,
			structuredData: JSON.stringify(processedContent.extractedData || {}),
			mediaCount: processedContent.media?.length || 0,
			internalLinksCount:
				processedContent.links?.filter((link: ExtractedLink) => link.isInternal)
					?.length || 0,
			externalLinksCount:
				processedContent.links?.filter(
					(link: ExtractedLink) => !link.isInternal,
				)?.length || 0,
		};

		const row = db
			.query(
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
			)
			.get(
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

		return row?.id ?? null;
	};

	/**
	 * Persists discovered links between pages to the database.
	 */
	const handleLinkPersistence = (
		db: Database,
		pageId: number | null,
		links: ExtractedLink[],
	): void => {
		if (!links.length || !pageId) {
			return;
		}

		const insertStmt = db.query(
			"INSERT OR IGNORE INTO links (source_id, target_url, text) VALUES (?, ?, ?)",
		);

		const transaction = db.transaction((linksToInsert: ExtractedLink[]) => {
			for (const link of linksToInsert) {
				try {
					insertStmt.run(pageId, link.url, link.text || "");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					logger.warn(`Failed to insert link: ${message}`);
				}
			}
		});

		try {
			transaction(links);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`Transaction failed for link persistence: ${message}`);
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
		if (!links.length || item.depth >= options.crawlDepth - 1) {
			return;
		}

		const filteredLinks = links.filter(
			(link: ExtractedLink) => !state.hasVisited(link.url),
		);
		if (!filteredLinks.length) {
			return;
		}

		if (!options.respectRobots) {
			filteredLinks.forEach((link: ExtractedLink) => {
				queue.enqueue({
					url: link.url,
					depth: item.depth + 1,
					retries: 0,
					parentUrl: item.url,
				});
			});
			return;
		}

		await processLinkBatch({
			links: filteredLinks,
			item,
			domain,
			targetDomain,
			options,
			state,
			dbPromise,
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
			fetchResult = await fetchContent(item);
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
				const backoffDelay = Math.min(1000 * 2 ** retries, 30000);
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

		const url = new URL(item.url);
		const domain = url.hostname;

		const sanitizedContent = contentType.includes("text/html")
			? sanitizeHtml(content, {
					allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
					allowedAttributes: {
						...sanitizeHtml.defaults.allowedAttributes,
						"*": ["class", "id", "style"],
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

		const db = await dbPromise;

		const pageId = storePageRecord({
			db,
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
		});

		// Reuse links already extracted by ContentProcessor instead of re-parsing HTML
		let links: ExtractedLink[] = [];
		if (contentType.includes("text/html") && processedContent.links?.length) {
			const baseHost = new URL(item.url).hostname;

			// Convert ContentProcessor links to crawlable links format
			links = processedContent.links
				.filter((link) => {
					// Skip non-HTTP protocols
					if (!link.url?.startsWith("http")) return false;
					// Skip external links unless full crawl mode
					if (options.crawlMethod !== "full" && !link.isInternal) return false;
					// Skip file extensions that aren't HTML
					if (/\.(css|js|json|xml|txt|md|csv|svg|ico|git|gitignore)$/i.test(link.url)) return false;
					return true;
				})
				.map((link) => ({
					url: link.url,
					text: link.text || "",
					isInternal: link.isInternal ?? link.domain === baseHost,
				}));

			state.addLinks(processedContent.links.length);
			handleLinkPersistence(db, pageId, processedContent.links);
		}

		if (
			options.saveMedia &&
			(options.crawlMethod === "media" || options.crawlMethod === "full") &&
			MEDIA_CONTENT_REGEX.test(contentType)
		) {
			state.addMedia(1);
		}

		const logMessage = buildEnhancedLog(
			item,
			statusCode,
			contentLength,
			processedContent,
		);
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
					jsonLd: (processedContent.extractedData?.jsonLd || []) as Record<
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
					wordCount: processedContent.analysis?.wordCount || 0,
					readingTime: processedContent.analysis?.readingTime || 0,
					language: processedContent.analysis?.language || "unknown",
					keywords: processedContent.analysis?.keywords || [],
					sentiment: processedContent.analysis?.sentiment || "neutral",
					readabilityScore: processedContent.analysis?.readabilityScore || 0,
					quality: processedContent.analysis?.quality,
				},
				media: processedContent.media || [],
				qualityScore: processedContent.analysis?.quality?.score || 0,
				language: processedContent.analysis?.language || "unknown",
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
	dbPromise: Promise<Database>;
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
	dbPromise,
	logger,
	queue,
}: ProcessLinkBatchOptions): Promise<void> {
	const CONCURRENCY = 10;

	const processSingleLink = async (link: ExtractedLink): Promise<void> => {
		try {
			const linkUrl = new URL(link.url);
			const linkDomain = linkUrl.hostname;

			if (linkDomain !== domain && linkDomain !== targetDomain) {
				const robots = await getRobotsRules(linkDomain, dbPromise, logger);
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
			const message = err instanceof Error ? err.message : String(err);
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
	const workers = new Array(Math.min(links.length, CONCURRENCY))
		.fill(null)
		.map(() => runTask(linksIterator));

	await Promise.all(workers);
}
