import type { Database } from "bun:sqlite";

export interface QueueItemRecord {
	url: string;
	depth: number;
	retries: number;
	parentUrl?: string;
	domain: string;
	availableAt?: number;
}

export function createCrawlQueueRepo(db: Database) {
	const insertItem = db.prepare(`
		INSERT OR IGNORE INTO crawl_queue_items (
			crawl_id,
			url,
			depth,
			retries,
			parent_url,
			domain,
			available_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	const upsertItem = db.prepare(`
		INSERT INTO crawl_queue_items (
			crawl_id,
			url,
			depth,
			retries,
			parent_url,
			domain,
			available_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(crawl_id, url) DO UPDATE SET
			depth = excluded.depth,
			retries = excluded.retries,
			parent_url = excluded.parent_url,
			domain = excluded.domain,
			available_at = excluded.available_at,
			created_at = CURRENT_TIMESTAMP
	`);

	const insertManyTransaction = db.transaction(
		(crawlId: string, items: QueueItemRecord[]) => {
			for (const item of items) {
				insertItem.run(
					crawlId,
					item.url,
					item.depth,
					item.retries,
					item.parentUrl ?? null,
					item.domain,
					item.availableAt ?? 0,
				);
			}
		},
	);

	return {
		enqueueMany(crawlId: string, items: QueueItemRecord[]): void {
			if (items.length === 0) return;
			insertManyTransaction(crawlId, items);
		},
		listPending(crawlId: string): QueueItemRecord[] {
			const rows = db
				.query(
					`
					SELECT url, depth, retries, parent_url, domain
						, available_at
					FROM crawl_queue_items
					WHERE crawl_id = ?
					ORDER BY available_at ASC, created_at ASC, id ASC
				`,
				)
				.all(crawlId) as Array<{
				url: string;
				depth: number;
				retries: number;
				parent_url: string | null;
				domain: string;
				available_at: number;
			}>;

			return rows.map((row) => ({
				url: row.url,
				depth: row.depth,
				retries: row.retries,
				parentUrl: row.parent_url ?? undefined,
				domain: row.domain,
				availableAt: row.available_at,
			}));
		},
		reschedule(crawlId: string, item: QueueItemRecord): void {
			upsertItem.run(
				crawlId,
				item.url,
				item.depth,
				item.retries,
				item.parentUrl ?? null,
				item.domain,
				item.availableAt ?? 0,
			);
		},
		remove(crawlId: string, url: string): void {
			db.query(
				"DELETE FROM crawl_queue_items WHERE crawl_id = ? AND url = ?",
			).run(crawlId, url);
		},
		clear(crawlId: string): void {
			db.query("DELETE FROM crawl_queue_items WHERE crawl_id = ?").run(crawlId);
		},
	};
}
