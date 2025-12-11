import { URL } from "node:url";
import axios from "axios";
import type Database from "better-sqlite3";
import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import type { Socket } from "socket.io";
import type { Logger } from "winston";
import { ContentProcessor } from "../../processors/ContentProcessor.js";
import type {
	ExtractedLink,
	ProcessedContent,
	QueueItem,
	SanitizedCrawlOptions,
} from "../../types.js";
import { extractMetadata, getRobotsRules } from "../../utils/helpers.js";
import type { DynamicRenderer } from "../dynamicRenderer.js";
import type { CrawlQueue } from "./crawlQueue.js";
import type { CrawlState } from "./crawlState.js";
import { extractLinks } from "./linkExtractor.js";

const MEDIA_CONTENT_REGEX = /image|video|audio|application\/(pdf|zip)/i;
const AXIOS_OPTIONS = {
	timeout: 15000,
	maxContentLength: 5 * 1024 * 1024,
	headers: {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		Accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.5",
		"Accept-Encoding": "gzip, deflate",
	},
};

interface PagePipelineParams {
	options: SanitizedCrawlOptions;
	state: CrawlState;
	logger: Logger;
	socket: Socket;
	dbPromise: Promise<Database.Database>;
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
	processedData: Record<string, unknown>;
}

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

	const emitStatsUpdate = (
		log: string,
		processedContent: ProcessedContent,
		item: QueueItem,
	): void => {
		socket.volatile.emit("stats", {
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

	const emitPageToClient = (page: PageRecord): void => {
		socket.emit("pageContent", page);
	};

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
			const response = await axios.get(item.url, AXIOS_OPTIONS);
			content = response.data;
			statusCode = response.status;
			contentType = response.headers["content-type"] || "";
			contentLength = Number.parseInt(
				response.headers["content-length"] || "0",
				10,
			);
			lastModified = response.headers["last-modified"] ?? null;
		}

		// Extract metadata from HTML content for title/description
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
		db: Database.Database;
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

		// Use RETURNING to get ID in one query (SQLite 3.35+)
		const row = db
			.prepare(
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

	const handleLinkPersistence = (
		db: Database.Database,
		pageId: number | null,
		links: ExtractedLink[],
	): void => {
		if (!links.length || !pageId) {
			return;
		}

		const insertStmt = db.prepare(
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

		// Use the batched processor
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

		// Check if session is still active before starting any async work
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

		// Sanitize HTML FIRST, then process the clean content (single parse)
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
			// Process the sanitized content instead of raw - one parse, not two
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

		let links: ExtractedLink[] = [];
		if (contentType.includes("text/html")) {
			// Explicitly load sanitized content to ensure we don't extract links
			// from malicious scripts or hidden elements that were stripped out.
			const parser = cheerio.load(sanitizedContent);
			links = extractLinks(parser, item.url, options);
			state.addLinks(links.length);
			handleLinkPersistence(db, pageId, links);
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
				extractedData: processedContent.extractedData || {},
				metadata: processedContent.metadata || {},
				analysis: processedContent.analysis || {},
				media: processedContent.media || [],
				qualityScore: processedContent.analysis?.quality?.score || 0,
				keywords: processedContent.analysis?.keywords || [],
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
	dbPromise: Promise<Database.Database>;
	logger: Logger;
	queue: CrawlQueue;
}

// Helper for batched link processing with proper concurrency limiting
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
				if (robots && !robots.isAllowed(link.url, "MikuCrawler")) {
					logger.debug(`Skipping ${link.url} - disallowed by robots.txt`);
					state.recordSkip();
					return;
				}

				const crawlDelay = robots?.getCrawlDelay?.("MikuCrawler");
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

	// Worker pool pattern for proper concurrency control
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
