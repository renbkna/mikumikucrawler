import type { Database } from "bun:sqlite";
import {
	CRAWL_PAGE_SNAPSHOT_LIMIT,
	type CrawlPageSummary,
	type CrawlPagesResponse,
} from "../../../shared/contracts/index.js";

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

export const EXPORT_PAGE_FIELDS = [
	"id",
	"url",
	"title",
	"description",
	"contentType",
	"domain",
	"content",
	"crawledAt",
] as const satisfies readonly (keyof ExportPageRow)[];

export const CSV_EXPORT_PAGE_FIELDS = [
	"id",
	"url",
	"title",
	"description",
	"contentType",
	"domain",
	"crawledAt",
] as const satisfies readonly (keyof ExportPageRow)[];

export type PageRepo = ReturnType<typeof createPageRepo>;

interface PageSummaryRow {
	id: number;
	url: string;
	title: string | null;
	description: string | null;
	contentType: string | null;
	domain: string;
}

export function createPageRepo(db: Database) {
	const exportWithContent = db.query<ExportPageRow, [string]>(`
		SELECT id, url, title, description,
			content_type AS contentType,
			domain,
			COALESCE(NULLIF(main_content, ''), content) AS content,
			crawled_at AS crawledAt
		FROM pages
		WHERE crawl_id = ?
		ORDER BY crawled_at DESC, id DESC
	`);
	const exportWithoutContent = db.query<ExportPageRow, [string]>(`
		SELECT id, url, title, description,
			content_type AS contentType,
			domain,
			NULL AS content,
			crawled_at AS crawledAt
		FROM pages
		WHERE crawl_id = ?
		ORDER BY crawled_at DESC, id DESC
	`);
	const listSummaries = db.query<PageSummaryRow, [string, number]>(`
		SELECT
			id,
			url,
			title,
			description,
			content_type AS contentType,
			domain
		FROM pages
		WHERE crawl_id = ?
		ORDER BY crawled_at DESC, id DESC
		LIMIT ?
	`);
	const countByCrawlId = db.query<{ count: number }, [string]>(
		"SELECT COUNT(*) AS count FROM pages WHERE crawl_id = ?",
	);

	return {
		getContentById(id: number): string | null | undefined {
			const row = db.query("SELECT content FROM pages WHERE id = ? LIMIT 1").get(id) as {
				content: string | null;
			} | null;
			if (row === null) return undefined;
			return row.content;
		},
		listSnapshot(crawlId: string): CrawlPagesResponse {
			const pages: CrawlPageSummary[] = Array.from(
				listSummaries.iterate(crawlId, CRAWL_PAGE_SNAPSHOT_LIMIT),
				(row) => ({
					id: row.id,
					url: row.url,
					...(row.title ? { title: row.title } : {}),
					...(row.description ? { description: row.description } : {}),
					...(row.contentType ? { contentType: row.contentType } : {}),
					domain: row.domain,
				}),
			);
			return {
				pages,
				count: countByCrawlId.get(crawlId)?.count ?? 0,
			};
		},
		iterateForExport(
			crawlId: string,
			options: { includeContent: boolean } = { includeContent: true },
		): IterableIterator<ExportPageRow> {
			return (options.includeContent ? exportWithContent : exportWithoutContent).iterate(crawlId);
		},
	};
}
