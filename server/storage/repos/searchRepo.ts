import type { Database } from "bun:sqlite";
import type { SearchResult } from "../../contracts/search.js";

type SearchResultRow = SearchResult;

function mapSearchResultRow(row: SearchResultRow): SearchResult {
	return {
		id: row.id,
		crawlId: row.crawlId,
		url: row.url,
		title: row.title,
		description: row.description,
		domain: row.domain,
		crawledAt: row.crawledAt,
		wordCount: row.wordCount,
		qualityScore: row.qualityScore,
		titleHighlight: row.titleHighlight,
		snippet: row.snippet,
	};
}

export function createSearchRepo(db: Database) {
	return {
		count(query: string): number {
			const row = db
				.query(
					`
					SELECT COUNT(*) AS count
					FROM pages_fts
					JOIN pages p ON p.id = pages_fts.rowid
					WHERE pages_fts MATCH ?
				`,
				)
				.get(query) as { count: number };
			return row.count;
		},
		search(query: string, limit: number): SearchResult[] {
			const rows = db
				.query(
					`
					SELECT
						p.id,
						p.crawl_id as crawlId,
						p.url,
						COALESCE(p.title, '') as title,
						COALESCE(p.description, '') as description,
						p.domain,
						strftime('%Y-%m-%dT%H:%M:%SZ', p.crawled_at) as crawledAt,
						p.word_count as wordCount,
						p.quality_score as qualityScore,
						COALESCE(
							highlight(pages_fts, 1, '<mark>', '</mark>'),
							COALESCE(p.title, '')
							) AS titleHighlight,
							COALESCE(
								NULLIF(
									REPLACE(REPLACE(
										CASE
											WHEN instr(snippet(pages_fts, 1, '<mark>', '</mark>', '…', 32), '<mark>') > 0
											THEN snippet(pages_fts, 1, '<mark>', '</mark>', '…', 32)
											ELSE ''
										END,
										'<mark>',
										''
									), '</mark>', ''),
									''
								),
								NULLIF(
									REPLACE(REPLACE(
										CASE
											WHEN instr(snippet(pages_fts, 2, '<mark>', '</mark>', '…', 32), '<mark>') > 0
											THEN snippet(pages_fts, 2, '<mark>', '</mark>', '…', 32)
											ELSE ''
										END,
										'<mark>',
										''
									), '</mark>', ''),
									''
								),
								NULLIF(
									REPLACE(REPLACE(
										CASE
											WHEN instr(snippet(pages_fts, 3, '<mark>', '</mark>', '…', 32), '<mark>') > 0
											THEN snippet(pages_fts, 3, '<mark>', '</mark>', '…', 32)
											ELSE ''
										END,
										'<mark>',
										''
									), '</mark>', ''),
									''
								),
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
						) AS snippet
					FROM pages_fts
					JOIN pages p ON p.id = pages_fts.rowid
					WHERE pages_fts MATCH ?
					ORDER BY rank
					LIMIT ?
				`,
				)
				.all(query, limit) as SearchResultRow[];
			return rows.map(mapSearchResultRow);
		},
	};
}
