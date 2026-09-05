import type { Database } from "bun:sqlite";
import {
	CRAWL_PAGE_SNAPSHOT_LIMIT,
	type CrawlPageDetails,
	type CrawlPageSummary,
	type CrawlPagesResponse,
	type ExportPageRow,
	isCrawlPageDetails,
	PAGE_TEXT_LIMITS,
} from "../../../shared/contracts/index.js";
import { truncateUtf8Text } from "../../../shared/text.js";
import type { OwnStatement } from "../db.js";

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
	const exportIds = own(
		db.query<{ id: number }, [string]>(`
			SELECT id FROM pages WHERE crawl_id = ? ORDER BY crawled_at DESC, id DESC
		`),
	);
	const exportPage = own(
		db.query<ExportPageRow, [boolean, number, string]>(`
		SELECT id, url, title, description,
			content_type AS contentType,
			domain,
			CASE WHEN ? THEN search_content ELSE NULL END AS content,
			crawled_at AS crawledAt
		FROM pages WHERE id = ? AND crawl_id = ?
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
		getContentById(crawlId: string, id: number): string | null | undefined {
			const row = db
				.query("SELECT content FROM pages WHERE crawl_id = ? AND id = ? LIMIT 1")
				.get(crawlId, id) as {
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
			// Snapshot membership, not bodies. Stored pages are immutable; no cursor spans a yield.
			const ids = exportIds.all(crawlId);
			const { includeContent } = options;
			return (function* () {
				for (const { id } of ids) {
					const page = exportPage.get(includeContent, id, crawlId);
					if (!page) throw new Error(`Crawl ${crawlId} was deleted during export`);
					yield page;
				}
			})();
		},
	};
}
