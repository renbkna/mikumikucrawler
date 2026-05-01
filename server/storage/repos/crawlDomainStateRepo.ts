import type { Database } from "bun:sqlite";

export interface CrawlDomainStateRecord {
	delayKey: string;
	delayMs: number;
	nextAllowedAt: number;
}

export function createCrawlDomainStateRepo(db: Database) {
	const upsert = db.prepare(`
		INSERT INTO crawl_domain_state (
			crawl_id,
			delay_key,
			delay_ms,
			next_allowed_at
		) VALUES (?, ?, ?, ?)
		ON CONFLICT(crawl_id, delay_key) DO UPDATE SET
			delay_ms = excluded.delay_ms,
			next_allowed_at = excluded.next_allowed_at,
			updated_at = CURRENT_TIMESTAMP
	`);

	return {
		upsert(crawlId: string, record: CrawlDomainStateRecord): void {
			upsert.run(
				crawlId,
				record.delayKey,
				record.delayMs,
				record.nextAllowedAt,
			);
		},
		listByCrawlId(crawlId: string): CrawlDomainStateRecord[] {
			const rows = db
				.query(
					`
					SELECT delay_key, delay_ms, next_allowed_at
					FROM crawl_domain_state
					WHERE crawl_id = ?
					ORDER BY delay_key ASC
				`,
				)
				.all(crawlId) as Array<{
				delay_key: string;
				delay_ms: number;
				next_allowed_at: number;
			}>;

			return rows.map((row) => ({
				delayKey: row.delay_key,
				delayMs: row.delay_ms,
				nextAllowedAt: row.next_allowed_at,
			}));
		},
	};
}
