import type { Database } from "bun:sqlite";
import type { TerminalOutcome } from "../../domain/crawl/CrawlState.js";

export interface TerminalUrlRecord {
	url: string;
	outcome: TerminalOutcome;
}

/**
 * Durable terminal URL state for resume semantics.
 *
 * Every admitted URL that reaches a terminal outcome is persisted here so a
 * resumed crawl can restore visited/terminal identity for success, failure,
 * and skip paths instead of only successful page rows.
 */
export function createCrawlTerminalRepo(db: Database) {
	const upsertTerminal = db.prepare(`
		INSERT INTO crawl_terminal_urls (
			crawl_id,
			url,
			outcome
		) VALUES (?, ?, ?)
		ON CONFLICT(crawl_id, url) DO UPDATE SET
			outcome = excluded.outcome,
			recorded_at = CURRENT_TIMESTAMP
	`);

	return {
		upsert(crawlId: string, url: string, outcome: TerminalOutcome): void {
			upsertTerminal.run(crawlId, url, outcome);
		},
		listByCrawlId(crawlId: string): TerminalUrlRecord[] {
			return db
				.query(
					`
					SELECT url, outcome
					FROM crawl_terminal_urls
					WHERE crawl_id = ?
					ORDER BY recorded_at ASC, url ASC
				`,
				)
				.all(crawlId) as TerminalUrlRecord[];
		},
	};
}
