import type { Database } from "bun:sqlite";

export function createSearchRepo(db: Database) {
	return {
		search(query: string, limit: number) {
			return db
				.query(
					`
					SELECT
						p.id,
						p.crawl_id as crawlId,
						p.url,
						COALESCE(p.title, '') as title,
						COALESCE(p.description, '') as description,
						p.domain,
						p.crawled_at as crawledAt,
						p.word_count as wordCount,
						p.quality_score as qualityScore,
						highlight(pages_fts, 1, '<mark>', '</mark>') AS titleHighlight,
						snippet(pages_fts, 3, '<mark>', '</mark>', '…', 32) AS snippet
					FROM pages_fts
					JOIN pages p ON p.id = pages_fts.rowid
					WHERE pages_fts MATCH ?
					ORDER BY rank
					LIMIT ?
				`,
				)
				.all(query, limit);
		},
	};
}
