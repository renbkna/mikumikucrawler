import type { Database } from "bun:sqlite";
import type { CrawlCounters } from "../../../shared/contracts/index.js";
import type { TerminalOutcome } from "../../domain/crawl/CrawlState.js";
import { createPageWriter, type SavePageInput } from "./pageRepo.js";

export interface CommitCompletedItemInput {
	crawlId: string;
	url: string;
	outcome?: TerminalOutcome;
	domainBudgetCharged: boolean;
	page?: Omit<SavePageInput, "crawlId" | "url">;
	counters: CrawlCounters;
	eventSequence: number;
}

export interface CommitCompletedItemResult {
	pageId?: number;
}

export interface TerminalUrlRecord {
	url: string;
	outcome: TerminalOutcome;
	domainBudgetCharged: boolean;
}

export function createCrawlItemPersistence(db: Database) {
	const pageWriter = createPageWriter(db);
	const insertTerminal = db.prepare(`
		INSERT INTO crawl_terminal_urls (
				crawl_id,
				url,
				outcome,
				domain_budget_charged
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(crawl_id, url) DO NOTHING
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
			const pageId = input.page
				? pageWriter.savePage({
						...input.page,
						crawlId: input.crawlId,
						url: input.url,
					})
				: undefined;

			if (input.outcome) {
				insertTerminal.run(
					input.crawlId,
					input.url,
					input.outcome,
					input.domainBudgetCharged ? 1 : 0,
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

			return {
				...(pageId !== undefined ? { pageId } : {}),
			};
		},
	);

	return {
		commitCompletedItem(input: CommitCompletedItemInput): CommitCompletedItemResult {
			return commitCompletedTransaction(input);
		},
		listTerminalUrls(crawlId: string): TerminalUrlRecord[] {
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
