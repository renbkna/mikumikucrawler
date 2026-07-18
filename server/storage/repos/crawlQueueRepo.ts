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
		INSERT INTO crawl_queue_items (
			crawl_id,
			url,
			depth,
			retries,
			parent_url,
			domain,
			available_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	const updateItem = db.prepare(`
		UPDATE crawl_queue_items
		SET
			depth = ?,
			retries = ?,
			parent_url = ?,
			domain = ?,
			available_at = ?,
			created_at = CURRENT_TIMESTAMP
		WHERE crawl_id = ? AND url = ?
	`);

	const insertManyTransaction = db.transaction((crawlId: string, items: QueueItemRecord[]) => {
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
	});

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
				domain: row.domain,
				availableAt: row.available_at,
				...(row.parent_url === null ? {} : { parentUrl: row.parent_url }),
			}));
		},
		reschedule(crawlId: string, item: QueueItemRecord): void {
			const result = updateItem.run(
				item.depth,
				item.retries,
				item.parentUrl ?? null,
				item.domain,
				item.availableAt ?? 0,
				crawlId,
				item.url,
			);
			if (result.changes !== 1) {
				throw new Error(`Cannot reschedule non-pending crawl URL: ${item.url}`);
			}
		},
		clear(crawlId: string): void {
			db.query("DELETE FROM crawl_queue_items WHERE crawl_id = ?").run(crawlId);
		},
	};
}
