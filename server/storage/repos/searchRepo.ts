import type { Database } from "bun:sqlite";
import { PAGE_TEXT_LIMITS } from "../../../shared/contracts/index.js";
import type { SearchResult } from "../../../shared/contracts/search.js";

/** Builds an FTS5 query that prefix-matches every whitespace-separated term literally. */
function buildFtsQuery(text: string): string | null {
	const terms = text
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((term) => `"${term.replaceAll('"', '""')}"*`);
	return terms.length === 0 ? null : terms.join(" ");
}

export function createSearchRepo(db: Database) {
	const countMatches = db.prepare<{ count: number }, [string, string]>(`
		SELECT COUNT(*) AS count
		FROM pages_fts
		JOIN pages p ON p.id = pages_fts.rowid
		WHERE p.crawl_id = ? AND pages_fts MATCH ?
	`);
	const searchMatches = db.prepare<SearchResult, [string, string, number]>(`
		SELECT
			p.id,
			p.url,
			SUBSTR(COALESCE(p.title, ''), 1, ${PAGE_TEXT_LIMITS.summaryTextCharacters}) AS title,
			SUBSTR(COALESCE(p.description, ''), 1, ${PAGE_TEXT_LIMITS.summaryTextCharacters}) AS description,
			p.domain,
			SUBSTR(
				COALESCE(
					snippet(pages_fts, -1, '', '', '…', 32),
					substr(
						COALESCE(
							NULLIF(p.search_content, ''),
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
	`);

	return {
		/** Searches a crawl's stored pages for user text; the repo owns FTS query syntax. */
		search(
			crawlId: string,
			text: string,
			limit: number,
		): { count: number; results: SearchResult[] } {
			const query = buildFtsQuery(text);
			if (query === null) return { count: 0, results: [] };
			return {
				count: countMatches.get(crawlId, query)?.count ?? 0,
				results: searchMatches.all(crawlId, query, limit),
			};
		},
	};
}
