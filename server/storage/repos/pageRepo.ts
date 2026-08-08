import type { Database } from "bun:sqlite";
import {
	CRAWL_PAGE_SNAPSHOT_LIMIT,
	type CrawlPageDetails,
	type CrawlPageSummary,
	type CrawlPagesResponse,
	isCrawlPageDetails,
	PAGE_TEXT_LIMITS,
} from "../../../shared/contracts/index.js";
import { truncateUtf8Text } from "../../../shared/text.js";
import type { OwnStatement } from "../db.js";

export interface ExportPageRow {
	id: number;
	url: string;
	title: string | null;
	description: string | null;
	contentType: string | null;
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

interface PageSummaryRow {
	id: number;
	url: string;
	title: string | null;
	description: string | null;
	contentType: string | null;
	domain: string;
	wordCount: number | null;
	readingTime: number | null;
	language: string | null;
}

function readPageDetails(row: PageSummaryRow): CrawlPageDetails {
	const details = {
		...(row.wordCount !== null ? { wordCount: row.wordCount } : {}),
		...(row.readingTime !== null ? { readingTime: row.readingTime } : {}),
		...(row.language !== null
			? { language: truncateUtf8Text(row.language, PAGE_TEXT_LIMITS.languageBytes) }
			: {}),
	};
	if (!isCrawlPageDetails(details)) {
		throw new Error("Stored page details violate the recovery contract");
	}
	return details;
}

export function createPageRepo(db: Database, own: OwnStatement) {
	const exportWithContent = own(
		db.query<ExportPageRow, [string]>(`
		SELECT id, url, title, description,
			content_type AS contentType,
			domain,
			COALESCE(NULLIF(main_content, ''), content) AS content,
			crawled_at AS crawledAt
		FROM pages
		WHERE crawl_id = ?
		ORDER BY crawled_at DESC, id DESC
	`),
	);
	const exportWithoutContent = own(
		db.query<ExportPageRow, [string]>(`
		SELECT id, url, title, description,
			content_type AS contentType,
			domain,
			NULL AS content,
			crawled_at AS crawledAt
		FROM pages
		WHERE crawl_id = ?
		ORDER BY crawled_at DESC, id DESC
	`),
	);
	const listSummaries = own(
		db.query<PageSummaryRow, [string, number]>(`
		SELECT
			id,
			url,
			substr(title, 1, ${PAGE_TEXT_LIMITS.summaryTextCharacters}) AS title,
			substr(description, 1, ${PAGE_TEXT_LIMITS.summaryTextCharacters}) AS description,
			content_type AS contentType,
			domain,
			word_count AS wordCount,
			reading_time AS readingTime,
			language
		FROM pages
		WHERE crawl_id = ?
		ORDER BY crawled_at DESC, id DESC
		LIMIT ?
	`),
	);
	const countByCrawlId = own(
		db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM pages WHERE crawl_id = ?"),
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
					details: readPageDetails(row),
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
