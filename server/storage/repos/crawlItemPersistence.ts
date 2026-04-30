import type { Database } from "bun:sqlite";
import type { CrawlCounters } from "../../../shared/contracts/crawl.js";
import type { TerminalOutcome } from "../../domain/crawl/CrawlState.js";
import { createPageWriter, type SavePageInput } from "./pageRepo.js";

export interface CommitCompletedItemInput {
	crawlId: string;
	url: string;
	outcome?: TerminalOutcome;
	page?: SavePageInput;
	counters: CrawlCounters;
	eventSequence: number;
}

export interface CommitCompletedItemResult {
	pageId?: number;
}

export function createCrawlItemPersistence(db: Database) {
	const pageWriter = createPageWriter(db);
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

	const removeQueueItem = db.prepare(
		"DELETE FROM crawl_queue_items WHERE crawl_id = ? AND url = ?",
	);

	const updateProgress = db.prepare(`
		UPDATE crawl_runs
		SET
			updated_at = CURRENT_TIMESTAMP,
			pages_scanned = ?,
			success_count = ?,
			failure_count = ?,
			skipped_count = ?,
			links_found = ?,
			media_files = ?,
			total_data_kb = ?,
			event_sequence = ?
		WHERE id = ?
	`);

	const commitCompletedTransaction = db.transaction(
		(input: CommitCompletedItemInput): CommitCompletedItemResult => {
			const pageId = input.page ? pageWriter.savePage(input.page) : undefined;

			if (input.outcome) {
				upsertTerminal.run(input.crawlId, input.url, input.outcome);
			}

			removeQueueItem.run(input.crawlId, input.url);
			updateProgress.run(
				input.counters.pagesScanned,
				input.counters.successCount,
				input.counters.failureCount,
				input.counters.skippedCount,
				input.counters.linksFound,
				input.counters.mediaFiles,
				input.counters.totalDataKb,
				input.eventSequence,
				input.crawlId,
			);

			return { pageId };
		},
	);

	return {
		commitCompletedItem(
			input: CommitCompletedItemInput,
		): CommitCompletedItemResult {
			return commitCompletedTransaction(input);
		},
	};
}
