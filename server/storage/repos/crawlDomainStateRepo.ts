import type { Database } from "bun:sqlite";
import type { DomainStateRecord } from "../../domain/crawl/CrawlState.js";

interface DomainStateRow {
	delayKey: string;
	delayMs: number;
	nextAllowedAt: number;
}

/** Persists the scheduler projection; schema CHECK constraints own the value bounds. */
export function createCrawlDomainStateRepo(db: Database) {
	const upsert = db.prepare<never, [string, string, number, number]>(`
		INSERT INTO crawl_domain_state (crawl_id, delay_key, delay_ms, next_allowed_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(crawl_id, delay_key) DO UPDATE SET
			delay_ms = excluded.delay_ms,
			next_allowed_at = excluded.next_allowed_at,
			updated_at = CURRENT_TIMESTAMP
	`);
	const listByCrawl = db.prepare<DomainStateRow, [string]>(`
		SELECT delay_key AS delayKey, delay_ms AS delayMs, next_allowed_at AS nextAllowedAt
		FROM crawl_domain_state
		WHERE crawl_id = ?
		ORDER BY delay_key ASC
	`);

	return {
		upsert(crawlId: string, record: DomainStateRecord): void {
			upsert.run(crawlId, record.delayKey, record.delayMs, record.nextAllowedAt);
		},
		listByCrawlId(crawlId: string): DomainStateRecord[] {
			return listByCrawl.all(crawlId);
		},
	};
}
