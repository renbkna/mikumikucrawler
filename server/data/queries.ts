import type { Database } from "bun:sqlite";
import type {
	CrawlStats,
	CrawledPage,
	ExtractedLink,
	LoggerLike,
	ProcessedContent,
	QueueItem,
	SanitizedCrawlOptions,
} from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";

// ──────────────────────────── Pages ────────────────────────────

interface CachedPageHeaders {
	last_modified: string | null;
	etag: string | null;
}

export function getCachedHeaders(
	db: Database,
	url: string,
): CachedPageHeaders | undefined {
	return db
		.query("SELECT last_modified, etag FROM pages WHERE url = ? LIMIT 1")
		.get(url) as CachedPageHeaders | undefined;
}

export function getPageByUrl(
	db: Database,
	url: string,
): CrawledPage | undefined {
	const row = db.query("SELECT * FROM pages WHERE url = ?").get(url) as
		| {
				id: number;
				url: string;
				content: string;
				title: string;
				description: string;
				content_type: string;
				domain: string;
		  }
		| undefined;

	if (!row) return undefined;

	return {
		id: row.id,
		url: row.url,
		content: row.content,
		title: row.title,
		description: row.description,
		contentType: row.content_type,
		domain: row.domain,
	};
}

export function getPageContentById(
	db: Database,
	id: number,
): string | undefined {
	const row = db.query("SELECT content FROM pages WHERE id = ?").get(id) as
		| { content: string | null }
		| undefined;
	if (row === undefined) return undefined;
	return row.content ?? "";
}

export function getAllPageUrls(db: Database): string[] {
	const rows = db.query("SELECT url FROM pages").all() as { url: string }[];
	return rows.map((r) => r.url);
}

export function updatePageTimestamp(db: Database, url: string): void {
	db.query(
		"UPDATE pages SET crawled_at = CURRENT_TIMESTAMP WHERE url = ?",
	).run(url);
}

// ──────────────────────────── Links ────────────────────────────

interface LinkRow {
	target_url: string;
	text: string;
}

export function getLinksBySourceId(
	db: Database,
	sourceId: number,
): { url: string; text: string }[] {
	const rows = db
		.query("SELECT target_url, text FROM links WHERE source_id = ?")
		.all(sourceId) as LinkRow[];
	return rows.map((l) => ({ url: l.target_url, text: l.text }));
}

export function getCachedLinksByPageUrl(
	db: Database,
	pageUrl: string,
): string[] {
	const rows = db
		.query(
			"SELECT target_url FROM links l JOIN pages p ON l.source_id = p.id WHERE p.url = ?",
		)
		.all(pageUrl) as { target_url: string }[];
	return rows.map((r) => r.target_url);
}

// ──────────────────────────── Domain Settings ────────────────────────────

export function getDomainRobotsTxt(
	db: Database,
	domain: string,
): string | undefined {
	const row = db
		.query("SELECT robots_txt FROM domain_settings WHERE domain = ?")
		.get(domain) as { robots_txt?: string } | undefined;
	return row?.robots_txt;
}

export function upsertDomainRobotsTxt(
	db: Database,
	domain: string,
	robotsTxt: string,
): void {
	db.query(
		"INSERT OR REPLACE INTO domain_settings (domain, robots_txt) VALUES (?, ?)",
	).run(domain, robotsTxt);
}

export function setDomainAllowed(
	db: Database,
	domain: string,
	allowed: boolean,
): void {
	db.query(
		"INSERT OR REPLACE INTO domain_settings (domain, allowed) VALUES (?, ?)",
	).run(domain, allowed ? 1 : 0);
}

// ──────────────────────────── Sessions ────────────────────────────

export type SessionStatus = "running" | "completed" | "interrupted";

export function saveSession(
	db: Database,
	sessionId: string,
	socketId: string,
	options: SanitizedCrawlOptions,
	logger?: LoggerLike,
): void {
	try {
		db.query(
			`INSERT OR REPLACE INTO crawl_sessions (id, socket_id, target, options, status, updated_at)
			 VALUES (?, ?, ?, ?, 'running', CURRENT_TIMESTAMP)`,
		).run(sessionId, socketId, options.target, JSON.stringify(options));
	} catch (err) {
		logger?.debug(
			`Failed to save session ${sessionId}: ${getErrorMessage(err)}`,
		);
	}
}

export function updateSessionStats(
	db: Database,
	sessionId: string,
	stats: CrawlStats,
	logger?: LoggerLike,
): void {
	try {
		db.query(
			`UPDATE crawl_sessions SET stats = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		).run(JSON.stringify(stats), sessionId);
	} catch (err) {
		logger?.debug(
			`Failed to update session stats for ${sessionId}: ${getErrorMessage(err)}`,
		);
	}
}

export function updateSessionStatus(
	db: Database,
	sessionId: string,
	status: SessionStatus,
	logger?: LoggerLike,
): void {
	try {
		db.query(
			`UPDATE crawl_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		).run(status, sessionId);
	} catch (err) {
		logger?.debug(
			`Failed to update session status for ${sessionId}: ${getErrorMessage(err)}`,
		);
	}
}

export function updateSessionSocketId(
	db: Database,
	sessionId: string,
	socketId: string,
): void {
	db.query(
		"UPDATE crawl_sessions SET socket_id = ?, status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
	).run(socketId, sessionId);
}

export function loadSession(
	db: Database,
	sessionId: string,
	logger?: LoggerLike,
): {
	options: SanitizedCrawlOptions;
	stats: CrawlStats | null;
	status: SessionStatus;
} | null {
	try {
		const row = db
			.query(
				`SELECT options, stats, status FROM crawl_sessions WHERE id = ? LIMIT 1`,
			)
			.get(sessionId) as
			| { options: string; stats: string | null; status: string }
			| undefined;

		if (!row) return null;

		const options = JSON.parse(row.options) as SanitizedCrawlOptions;
		const stats = row.stats ? (JSON.parse(row.stats) as CrawlStats) : null;
		const status = row.status as SessionStatus;
		return { options, stats, status };
	} catch (err) {
		const msg = `Failed to load session ${sessionId}: ${getErrorMessage(err)}`;
		if (logger) {
			logger.error(msg);
		} else {
			// biome-ignore lint/suspicious/noConsole: Logger unavailable during early session load
			console.error(msg);
		}
		return null;
	}
}

interface InterruptedSessionRow {
	id: string;
	target: string;
	status: string;
	stats: string | null;
	created_at: string;
	updated_at: string;
}

export function getInterruptedSessions(
	db: Database,
): InterruptedSessionRow[] {
	return db
		.query(
			`SELECT id, target, status, stats, created_at, updated_at
			 FROM crawl_sessions
			 WHERE status = 'interrupted'
			 ORDER BY updated_at DESC`,
		)
		.all() as InterruptedSessionRow[];
}

export function deleteSession(db: Database, sessionId: string): void {
	db.query("DELETE FROM queue_items WHERE session_id = ?").run(sessionId);
	db.query("DELETE FROM crawl_sessions WHERE id = ?").run(sessionId);
}

// ──────────────────────────── Queue Items ────────────────────────────

export function saveQueueItemBatch(
	db: Database,
	sessionId: string,
	items: QueueItem[],
	logger?: LoggerLike,
): void {
	if (items.length === 0) return;
	try {
		const stmt = db.prepare(
			`INSERT OR IGNORE INTO queue_items (session_id, url, depth, retries, parent_url, domain)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		const tx = db.transaction(() => {
			for (const item of items) {
				stmt.run(
					sessionId,
					item.url,
					item.depth,
					item.retries,
					item.parentUrl ?? null,
					item.domain,
				);
			}
		});
		tx();
	} catch (err) {
		logger?.debug(
			`Failed to save queue items for ${sessionId}: ${getErrorMessage(err)}`,
		);
	}
}

export function removeQueueItem(
	db: Database,
	sessionId: string,
	url: string,
	logger?: LoggerLike,
): void {
	try {
		db.query("DELETE FROM queue_items WHERE session_id = ? AND url = ?").run(
			sessionId,
			url,
		);
	} catch (err) {
		logger?.debug(
			`Failed to remove queue item ${url}: ${getErrorMessage(err)}`,
		);
	}
}

export function loadPendingQueueItems(
	db: Database,
	sessionId: string,
	logger?: LoggerLike,
): QueueItem[] {
	try {
		const rows = db
			.query(
				`SELECT url, depth, retries, parent_url, domain
				 FROM queue_items
				 WHERE session_id = ?
				 ORDER BY depth ASC`,
			)
			.all(sessionId) as {
			url: string;
			depth: number;
			retries: number;
			parent_url: string | null;
			domain: string;
		}[];

		return rows.map((row) => ({
			url: row.url,
			depth: row.depth,
			retries: row.retries,
			parentUrl: row.parent_url ?? undefined,
			domain: row.domain,
		}));
	} catch (err) {
		logger?.debug(
			`Failed to load queue items for ${sessionId}: ${getErrorMessage(err)}`,
		);
		return [];
	}
}

// ──────────────────────────── Page Pipeline (Prepared Statements) ────────────────────────────

export interface SavePageParams {
	url: string;
	domain: string;
	contentType: string;
	statusCode: number;
	contentLength: number;
	title: string;
	description: string;
	content: string | null;
	isDynamic: boolean;
	lastModified: string | null;
	etag: string | null;
	processedContent: ProcessedContent;
	links: ExtractedLink[];
}

export interface PageStatements {
	saveTransaction: (params: SavePageParams) => number | null;
}

export function createPageStatements(db: Database): PageStatements {
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

	const saveTransaction = db.transaction(
		(p: SavePageParams): number | null => {
			const enhancedData = {
				mainContent: p.processedContent.extractedData?.mainContent ?? "",
				wordCount: p.processedContent.analysis?.wordCount ?? 0,
				readingTime: p.processedContent.analysis?.readingTime ?? 0,
				language: p.processedContent.analysis?.language ?? "unknown",
				keywords: JSON.stringify(
					p.processedContent.analysis?.keywords ?? [],
				),
				qualityScore: p.processedContent.analysis?.quality?.score ?? 0,
				structuredData: JSON.stringify(
					p.processedContent.extractedData ?? {},
				),
				mediaCount: p.processedContent.media?.length ?? 0,
				internalLinksCount:
					p.processedContent.links?.filter(
						(link: ExtractedLink) => link.isInternal,
					)?.length ?? 0,
				externalLinksCount:
					p.processedContent.links?.filter(
						(link: ExtractedLink) => !link.isInternal,
					)?.length ?? 0,
			};

			const row = insertPageQuery.get(
				p.url,
				p.domain,
				p.contentType,
				p.statusCode,
				p.contentLength,
				p.title,
				p.description,
				p.content,
				p.isDynamic ? 1 : 0,
				p.lastModified,
				p.etag,
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

			if (pageId && p.links.length > 0) {
				for (const link of p.links) {
					insertLinkQuery.run(pageId, link.url, link.text ?? "");
				}
			}

			return pageId;
		},
	);

	return { saveTransaction };
}

// ──────────────────────────── Stats Aggregation (API) ────────────────────────────

export interface AggregateStats {
	totalPages: number;
	totalDataSize: number;
	uniqueDomains: number;
	lastCrawled: string;
	avgWordCount: number | null;
	avgQualityScore: number | null;
	avgReadingTime: number | null;
	totalMedia: number | null;
	totalInternalLinks: number | null;
	totalExternalLinks: number | null;
}

export function getAggregateStats(db: Database): AggregateStats {
	return db
		.query(
			`SELECT
				COUNT(*) as totalPages,
				SUM(data_length) as totalDataSize,
				COUNT(DISTINCT domain) as uniqueDomains,
				MAX(crawled_at) as lastCrawled,
				AVG(word_count) as avgWordCount,
				AVG(quality_score) as avgQualityScore,
				AVG(reading_time) as avgReadingTime,
				SUM(media_count) as totalMedia,
				SUM(internal_links_count) as totalInternalLinks,
				SUM(external_links_count) as totalExternalLinks
			FROM pages`,
		)
		.get() as AggregateStats;
}

export interface LanguageStat {
	language: string;
	count: number;
}

export function getLanguageStats(db: Database): LanguageStat[] {
	return db
		.query(
			`SELECT language, COUNT(*) as count
			FROM pages
			WHERE language IS NOT NULL AND language != 'unknown'
			GROUP BY language
			ORDER BY count DESC
			LIMIT 10`,
		)
		.all() as LanguageStat[];
}

export interface QualityStat {
	quality_range: string;
	count: number;
}

export function getQualityDistribution(db: Database): QualityStat[] {
	return db
		.query(
			`SELECT quality_range, COUNT(*) as count
			FROM (
				SELECT
					CASE
						WHEN quality_score >= 80 THEN 'High (80-100)'
						WHEN quality_score >= 60 THEN 'Medium (60-79)'
						WHEN quality_score >= 40 THEN 'Low (40-59)'
						ELSE 'Poor (0-39)'
					END AS quality_range
				FROM pages
				WHERE quality_score IS NOT NULL
			)
			GROUP BY quality_range
			ORDER BY count DESC`,
		)
		.all() as QualityStat[];
}

export function getPagesPaginated(
	db: Database,
	lastId: number,
	limit: number,
): (Record<string, unknown> & { id: number })[] {
	return db
		.query(
			`SELECT id, url, domain, crawled_at, status_code,
			 data_length, title, description
			 FROM pages WHERE id > ? ORDER BY id LIMIT ?`,
		)
		.all(lastId, limit) as (Record<string, unknown> & { id: number })[];
}

export interface SearchResult {
	id: number;
	url: string;
	title: string;
	description: string;
	domain: string;
	crawled_at: string;
	word_count: number | null;
	quality_score: number | null;
	title_hl: string;
	snippet: string;
}

export function searchPages(
	db: Database,
	ftsQuery: string,
	limit: number,
): SearchResult[] {
	return db
		.query(
			`SELECT
				p.id,
				p.url,
				p.title,
				p.description,
				p.domain,
				p.crawled_at,
				p.word_count,
				p.quality_score,
				highlight(pages_fts, 1, '<mark>', '</mark>') AS title_hl,
				snippet(pages_fts, 3, '<mark>', '</mark>', '…', 32) AS snippet
			FROM pages_fts
			JOIN pages p ON p.id = pages_fts.rowid
			WHERE pages_fts MATCH ?
			ORDER BY rank
			LIMIT ?`,
		)
		.all(ftsQuery, limit) as SearchResult[];
}
