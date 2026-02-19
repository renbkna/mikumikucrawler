import type { Database } from "bun:sqlite";
import sanitizeHtml from "sanitize-html";
import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import {
	BATCH_CONSTANTS,
	RETRY_CONSTANTS,
	SOFT_404_CONSTANTS,
} from "../../constants.js";
import { ContentProcessor } from "../../processors/ContentProcessor.js";
import type {
	CrawlerSocket,
	ExtractedLink,
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
import { updateSessionStats } from "../../utils/sessionPersistence.js";
import type { DynamicRenderer } from "../dynamicRenderer.js";
import type { CrawlQueue } from "./crawlQueue.js";
import type { CrawlState } from "./crawlState.js";
import { fetchContent } from "./fetcher.js";

interface RobotsDirectives {
	noindex: boolean;
	nofollow: boolean;
}

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

interface PagePipelineParams {
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

		return segments.join(" | ");
	};

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

		updateSessionStats(db, sessionId, currentStats);
	};

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

	const enqueueLinksWithPolicies = async (
		links: ExtractedLink[],
		item: QueueItem,
		domain: string,
	): Promise<void> => {
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

		if (state.isDomainBudgetExceeded(item.domain)) {
			logger.debug(
				`[Budget] Domain budget exceeded for ${item.domain}, skipping ${item.url}`,
			);
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

		if (fetchResult.unchanged) {
			state.markVisited(item.url);
			state.recordSuccess(0);
			db.query(
				"UPDATE pages SET crawled_at = CURRENT_TIMESTAMP WHERE url = ?",
			).run(item.url);
			const unchangedLog = `[Crawler] Unchanged: ${item.url} (304)`;
			logger.info(unchangedLog);
			socket.emit("stats", { ...state.stats, log: unchangedLog });

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

		if (fetchResult.rateLimited) {
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

		state.adaptDomainDelay(item.domain, fetchMs, statusCode);

		state.markVisited(item.url);
		state.recordSuccess(contentLength);

		const domain = item.domain;

		const sanitizedContent = contentType.includes("text/html")
			? sanitizeHtml(content, {
					allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
					allowedAttributes: {
						...sanitizeHtml.defaults.allowedAttributes,
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

		if (
			options.saveMedia &&
			(options.crawlMethod === "media" || options.crawlMethod === "full") &&
			MEDIA_CONTENT_REGEX.test(contentType)
		) {
			state.addMedia(1);
		}

		const robotsDirectives = mergeRobotsDirectives(
			processedContent.metadata?.robots,
			xRobotsTag,
		);

		if (robotsDirectives.noindex) {
			const noindexLog = `[Robots] noindex: ${item.url} — skipping storage`;
			logger.info(noindexLog);
			socket.emit("stats", { ...state.stats, log: noindexLog });
			state.recordSkip();
			if (!robotsDirectives.nofollow) {
				await enqueueLinksWithPolicies(links, item, domain);
			}
			return;
		}

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
		logger.info(logMessage);
		emitStatsUpdate(logMessage, processedContent, item);
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
