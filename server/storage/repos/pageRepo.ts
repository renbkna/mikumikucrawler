import type { Database } from "bun:sqlite";
import type { ExtractedLink, ProcessedContent } from "../../types.js";

export interface SavePageInput {
	crawlId: string;
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

export interface ExportPageRow {
	id: number;
	url: string;
	title: string;
	description: string;
	contentType: string;
	domain: string;
	content: string | null;
	crawledAt: string;
}

export type PageRepo = ReturnType<typeof createPageRepo>;

export function createPageRepo(db: Database) {
	const insertPage = db.prepare(`
		INSERT INTO pages (
			crawl_id,
			url,
			domain,
			content_type,
			status_code,
			data_length,
			title,
			description,
			content,
			is_dynamic,
			last_modified,
			etag,
			main_content,
			word_count,
			reading_time,
			language,
			keywords,
			quality_score,
			structured_data,
			media_count,
			internal_links_count,
			external_links_count
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(crawl_id, url) DO UPDATE SET
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
		RETURNING id
	`);

	const clearLinks = db.prepare("DELETE FROM page_links WHERE page_id = ?");
	const insertLink = db.prepare(
		"INSERT OR IGNORE INTO page_links (page_id, target_url, text) VALUES (?, ?, ?)",
	);

	const saveTransaction = db.transaction((input: SavePageInput) => {
		const pageRow = insertPage.get(
			input.crawlId,
			input.url,
			input.domain,
			input.contentType,
			input.statusCode,
			input.contentLength,
			input.title,
			input.description,
			input.content,
			input.isDynamic ? 1 : 0,
			input.lastModified,
			input.etag,
			input.processedContent.extractedData?.mainContent ?? "",
			input.processedContent.analysis?.wordCount ?? 0,
			input.processedContent.analysis?.readingTime ?? 0,
			input.processedContent.analysis?.language ?? "unknown",
			JSON.stringify(input.processedContent.analysis?.keywords ?? []),
			input.processedContent.analysis?.quality?.score ?? 0,
			JSON.stringify(input.processedContent.extractedData ?? {}),
			input.processedContent.media?.length ?? 0,
			input.links.filter((link) => link.isInternal).length,
			input.links.filter((link) => !link.isInternal).length,
		) as { id: number };

		clearLinks.run(pageRow.id);
		for (const link of input.links) {
			insertLink.run(pageRow.id, link.url, link.text ?? "");
		}

		return pageRow.id;
	});

	return {
		save(input: SavePageInput): number {
			return saveTransaction(input);
		},
		getHeaders(
			crawlId: string,
			url: string,
		): { lastModified: string | null; etag: string | null } | null {
			const row = db
				.query(
					"SELECT last_modified, etag FROM pages WHERE crawl_id = ? AND url = ? LIMIT 1",
				)
				.get(crawlId, url) as {
				last_modified: string | null;
				etag: string | null;
			} | null;

			return row
				? {
						lastModified: row.last_modified,
						etag: row.etag,
					}
				: null;
		},
		getVisitedUrls(crawlId: string): string[] {
			const rows = db
				.query("SELECT url FROM pages WHERE crawl_id = ?")
				.all(crawlId) as Array<{ url: string }>;
			return rows.map((row) => row.url);
		},
		getContentById(id: number): string | null | undefined {
			const row = db
				.query("SELECT content FROM pages WHERE id = ? LIMIT 1")
				.get(id) as { content: string | null } | null;
			if (row === null) return undefined;
			return row.content;
		},
		getLinksByPageUrl(crawlId: string, pageUrl: string): string[] {
			const rows = db
				.query(
					`
					SELECT pl.target_url
					FROM page_links pl
					INNER JOIN pages p ON p.id = pl.page_id
					WHERE p.crawl_id = ? AND p.url = ?
				`,
				)
				.all(crawlId, pageUrl) as Array<{ target_url: string }>;
			return rows.map((row) => row.target_url);
		},
		listForExport(crawlId: string): ExportPageRow[] {
			return db
				.query(
					`
					SELECT id, url, title, description,
						content_type AS contentType, domain, content,
						crawled_at AS crawledAt
					FROM pages
					WHERE crawl_id = ?
					ORDER BY crawled_at DESC, id DESC
				`,
				)
				.all(crawlId) as ExportPageRow[];
		},
	};
}
