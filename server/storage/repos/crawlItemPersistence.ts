import type { Database } from "bun:sqlite";
import { type CrawlStatus, isActiveCrawlStatus } from "../../../shared/contracts/index.js";
import { kilobytesToBytes } from "../../../shared/text.js";
import {
	type CommittedTerminal,
	type CompletedPageData,
	deriveTerminalCounters,
	type TerminalCounterEffects,
	type TerminalOutcome,
} from "../../domain/crawl/completion.js";
import { type CrawlCounterColumns, countersFromColumns } from "./crawlRunRepo.js";

interface CommitCompletedItemBase {
	crawlId: string;
	url: string;
	domainBudgetCharged: boolean;
	chargedDomain?: string;
	eventSequence: number;
}

export type CommitCompletedItemInput = CommitCompletedItemBase &
	(
		| { outcome: "success"; page: CompletedPageData }
		| { outcome: Exclude<TerminalOutcome, "success">; page?: never }
	);

export type CommitCompletedItemResult = CommittedTerminal &
	({ type: "page-persisted"; pageId: number; pageCount: number } | { type: "no-page" });

export interface TerminalUrlRecord {
	url: string;
	outcome: TerminalOutcome;
	domainBudgetCharged: boolean;
	chargedDomain: string | null;
}

interface TerminalUrlRow {
	url: string;
	outcome: TerminalOutcome;
	domain_budget_charged: number;
	charged_domain: string | null;
}

export function createCrawlItemPersistence(
	db: Database,
	pages: { countByCrawlId(crawlId: string): number },
) {
	const insertPage = db.prepare<
		{ id: number },
		[string, string, string, string, string, string, string | null, string, number, number, string]
	>(`
		INSERT INTO pages (
			crawl_id, url, domain, content_type, title, description,
			content, main_content, word_count, reading_time, language
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING id
	`);
	const insertTerminal = db.prepare<
		never,
		[string, string, TerminalOutcome, number, string | null]
	>(`
		INSERT INTO crawl_terminal_urls (
			crawl_id, url, outcome, domain_budget_charged, charged_domain
		) VALUES (?, ?, ?, ?, ?)
	`);
	const takeQueueItem = db.prepare<{ domain: string }, [string, string]>(
		"DELETE FROM crawl_queue_items WHERE crawl_id = ? AND url = ? RETURNING domain",
	);
	const updateProgress = db.prepare<
		never,
		[number, number, number, number, number, number, number, number, string]
	>(`
		UPDATE crawl_runs
		SET
			updated_at = CURRENT_TIMESTAMP,
			pages_scanned = ?,
			success_count = ?,
			failure_count = ?,
			skipped_count = ?,
			links_found = ?,
			media_files = ?,
			total_data_bytes = ?,
			event_sequence = ?
		WHERE id = ?
	`);
	const getRunCounters = db.prepare<CrawlCounterColumns & { status: CrawlStatus }, [string]>(`
		SELECT status, pages_scanned, success_count, failure_count, skipped_count,
			links_found, media_files, total_data_bytes
		FROM crawl_runs
		WHERE id = ?
		LIMIT 1
	`);
	const listTerminal = db.prepare<TerminalUrlRow, [string]>(`
		SELECT url, outcome, domain_budget_charged, charged_domain
		FROM crawl_terminal_urls
		WHERE crawl_id = ?
		ORDER BY terminal_sequence ASC
	`);

	const commitCompletedTransaction = db.transaction(
		(input: CommitCompletedItemInput): CommitCompletedItemResult => {
			const run = getRunCounters.get(input.crawlId);
			if (!run || !isActiveCrawlStatus(run.status)) {
				throw new Error(`Cannot complete an item for inactive crawl ${input.crawlId}`);
			}
			const queueItem = takeQueueItem.get(input.crawlId, input.url);
			if (!queueItem) {
				throw new Error(`Cannot complete non-pending crawl URL: ${input.url}`);
			}
			const chargedDomain = input.domainBudgetCharged
				? (input.chargedDomain ?? queueItem.domain)
				: null;
			insertTerminal.run(
				input.crawlId,
				input.url,
				input.outcome,
				input.domainBudgetCharged ? 1 : 0,
				chargedDomain,
			);
			const page = input.page;
			const pageId = page
				? insertPage.get(
						input.crawlId,
						input.url,
						queueItem.domain,
						page.contentType,
						page.title,
						page.description,
						page.content,
						page.mainContent,
						page.wordCount,
						page.readingTime,
						page.language,
					)?.id
				: undefined;
			const effects: TerminalCounterEffects = page
				? {
						dataBytes: page.contentLength,
						mediaFiles: page.mediaCount,
						discoveredLinks: page.discoveredLinkCount,
					}
				: {};
			const counters = deriveTerminalCounters(countersFromColumns(run), input.outcome, effects);
			updateProgress.run(
				counters.pagesScanned,
				counters.successCount,
				counters.failureCount,
				counters.skippedCount,
				counters.linksFound,
				counters.mediaFiles,
				kilobytesToBytes(counters.totalDataKb),
				input.eventSequence,
				input.crawlId,
			);

			if (!page) {
				return { type: "no-page", counters, effects, chargedDomain };
			}
			if (pageId === undefined) {
				throw new Error("Persisted page completion did not return its page id");
			}
			const pageCount = pages.countByCrawlId(input.crawlId);
			if (pageCount < 1) {
				throw new Error("Persisted page completion did not produce a positive page count");
			}
			return { type: "page-persisted", pageId, pageCount, counters, effects, chargedDomain };
		},
	);

	return {
		commitCompletedItem(input: CommitCompletedItemInput): CommitCompletedItemResult {
			return commitCompletedTransaction(input);
		},
		listTerminalUrls(crawlId: string): TerminalUrlRecord[] {
			return listTerminal.all(crawlId).map((row) => ({
				url: row.url,
				outcome: row.outcome,
				domainBudgetCharged: row.domain_budget_charged === 1,
				chargedDomain: row.charged_domain,
			}));
		},
	};
}
