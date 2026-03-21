import type { Database } from "bun:sqlite";

export interface QueueItemRecord {
	url: string;
	depth: number;
	retries: number;
	parentUrl?: string;
	domain: string;
}

export function createCrawlQueueRepo(db: Database) {
	const insertItem = db.prepare(`
		INSERT OR IGNORE INTO crawl_queue_items (
			crawl_id,
			url,
			depth,
			retries,
			parent_url,
			domain
		) VALUES (?, ?, ?, ?, ?, ?)
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
					FROM crawl_queue_items
					WHERE crawl_id = ?
					ORDER BY created_at ASC, id ASC
				`,
				)
				.all(crawlId) as Array<{
				url: string;
				depth: number;
				retries: number;
				parent_url: string | null;
				domain: string;
			}>;

			return rows.map((row) => ({
				url: row.url,
				depth: row.depth,
				retries: row.retries,
				parentUrl: row.parent_url ?? undefined,
				domain: row.domain,
			}));
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
