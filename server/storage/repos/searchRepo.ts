import type { Database } from "bun:sqlite";
import { PAGE_TEXT_LIMITS } from "../../../shared/contracts/index.js";
import type { SearchResult } from "../../contracts/search.js";

export function createSearchRepo(db: Database) {
	return {
		count(crawlId: string, query: string): number {
			const row = db
				.query(
					`
					SELECT COUNT(*) AS count
					FROM pages_fts
					JOIN pages p ON p.id = pages_fts.rowid
					WHERE p.crawl_id = ? AND pages_fts MATCH ?
				`,
				)
				.get(crawlId, query) as { count: number };
			return row.count;
		},
		search(crawlId: string, query: string, limit: number): SearchResult[] {
			const rows = db
				.query(
					`
					SELECT
						p.id,
						p.url,
						SUBSTR(COALESCE(p.title, ''), 1, ${PAGE_TEXT_LIMITS.summaryTextCharacters}) as title,
						SUBSTR(COALESCE(p.description, ''), 1, ${PAGE_TEXT_LIMITS.summaryTextCharacters}) as description,
						p.domain,
						SUBSTR(
							COALESCE(
								snippet(pages_fts, -1, '', '', '…', 32),
								substr(
										COALESCE(
											NULLIF(p.main_content, ''),
											NULLIF(p.content, ''),
											NULLIF(p.description, ''),
											NULLIF(p.title, ''),
										p.url
									),
								1,
								240
							)
							),
							1,
							${PAGE_TEXT_LIMITS.searchSnippetCharacters}
						) AS snippet
					FROM pages_fts
					JOIN pages p ON p.id = pages_fts.rowid
					WHERE p.crawl_id = ? AND pages_fts MATCH ?
					ORDER BY rank
					LIMIT ?
				`,
				)
				.all(crawlId, query, limit) as SearchResult[];
			return rows;
		},
	};
}
