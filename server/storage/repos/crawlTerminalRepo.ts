import type { Database } from "bun:sqlite";
import type { TerminalOutcome } from "../../domain/crawl/CrawlState.js";

export interface TerminalUrlRecord {
	url: string;
	outcome: TerminalOutcome;
	domainBudgetCharged: boolean;
}

export function createCrawlTerminalWriter(db: Database) {
	const upsertTerminal = db.prepare(`
		INSERT INTO crawl_terminal_urls (
				crawl_id,
				url,
				outcome,
				domain_budget_charged
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(crawl_id, url) DO UPDATE SET
				outcome = excluded.outcome,
				domain_budget_charged = excluded.domain_budget_charged,
				recorded_at = CURRENT_TIMESTAMP
	`);

	return {
		upsert(
			crawlId: string,
			url: string,
			outcome: TerminalOutcome,
			domainBudgetCharged: boolean,
		): void {
			upsertTerminal.run(crawlId, url, outcome, domainBudgetCharged ? 1 : 0);
		},
	};
}

/**
 * Durable terminal URL state for resume semantics.
 *
 * Every admitted URL that reaches a terminal outcome is persisted here so a
 * resumed crawl can restore visited/terminal identity for success, failure,
 * and skip paths instead of only successful page rows.
 */
export function createCrawlTerminalRepo(db: Database) {
	const writer = createCrawlTerminalWriter(db);

	return {
		upsert: writer.upsert,
		listByCrawlId(crawlId: string): TerminalUrlRecord[] {
			const rows = db
				.query(
					`
						SELECT url, outcome, domain_budget_charged
						FROM crawl_terminal_urls
						WHERE crawl_id = ?
						ORDER BY terminal_sequence ASC
					`,
				)
				.all(crawlId) as Array<{
				url: string;
				outcome: TerminalOutcome;
				domain_budget_charged: number;
			}>;
			return rows.map((row) => ({
				url: row.url,
				outcome: row.outcome,
				domainBudgetCharged: row.domain_budget_charged === 1,
			}));
		},
	};
}
