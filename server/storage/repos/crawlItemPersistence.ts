import type { Database } from "bun:sqlite";
import type { CrawlCounters } from "../../../shared/contracts/crawl.js";
import type { TerminalOutcome } from "../../domain/crawl/CrawlState.js";
import { createPageWriter, type SavePageInput } from "./pageRepo.js";
import { createCrawlTerminalWriter } from "./crawlTerminalRepo.js";

export interface CommitCompletedItemInput {
	crawlId: string;
	url: string;
	outcome?: TerminalOutcome;
	domainBudgetCharged: boolean;
	page?: SavePageInput;
	counters: CrawlCounters;
	eventSequence: number;
}

export interface CommitCompletedItemResult {
	pageId?: number;
}

export function createCrawlItemPersistence(db: Database) {
	const pageWriter = createPageWriter(db);
	const terminalWriter = createCrawlTerminalWriter(db);

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
				terminalWriter.upsert(
					input.crawlId,
					input.url,
					input.outcome,
					input.domainBudgetCharged,
				);
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
