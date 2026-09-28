import type { Database } from "bun:sqlite";

export interface QueueItemRecord {
	url: string;
	depth: number;
	retries: number;
	parentUrl?: string;
	domain: string;
	availableAt: number;
}

interface QueueItemRow {
	url: string;
	depth: number;
	retries: number;
	parent_url: string | null;
	domain: string;
	available_at: number;
}

export function createCrawlQueueRepo(db: Database) {
	const insertItem = db.prepare<
		never,
		[string, string, number, number, string | null, string, number]
	>(`
		INSERT INTO crawl_queue_items (
			crawl_id, url, depth, retries, parent_url, domain, available_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	const updateItem = db.prepare<
		never,
		[number, number, string | null, string, number, string, string]
	>(`
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
	const listItems = db.prepare<QueueItemRow, [string]>(`
		SELECT url, depth, retries, parent_url, domain, available_at
		FROM crawl_queue_items
		WHERE crawl_id = ?
		ORDER BY available_at ASC, created_at ASC, id ASC
	`);
	const clearItems = db.prepare<never, [string]>(
		"DELETE FROM crawl_queue_items WHERE crawl_id = ?",
	);

	const insertManyTransaction = db.transaction((crawlId: string, items: QueueItemRecord[]) => {
		for (const item of items) {
			insertItem.run(
				crawlId,
				item.url,
				item.depth,
				item.retries,
				item.parentUrl ?? null,
				item.domain,
				item.availableAt,
			);
		}
	});

	return {
		enqueueMany(crawlId: string, items: QueueItemRecord[]): void {
			if (items.length === 0) return;
			insertManyTransaction(crawlId, items);
		},
		listPending(crawlId: string): QueueItemRecord[] {
			return listItems.all(crawlId).map((row) => ({
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
				item.availableAt,
				crawlId,
				item.url,
			);
			if (result.changes !== 1) {
				throw new Error(`Cannot reschedule non-pending crawl URL: ${item.url}`);
			}
		},
		clear(crawlId: string): void {
			clearItems.run(crawlId);
		},
	};
}
