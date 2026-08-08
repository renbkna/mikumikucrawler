import type { Database } from "bun:sqlite";
import type { CrawlCounters } from "../../../shared/contracts/index.js";
import { isActiveCrawlStatus } from "../../../shared/contracts/index.js";
import { bytesToKilobytes, kilobytesToBytes } from "../../../shared/text.js";
import {
	deriveTerminalCounters,
	type TerminalCounterEffects,
	type TerminalOutcome,
} from "../../domain/crawl/CrawlState.js";
import type { OwnStatement } from "../db.js";

export interface CompletedPageData {
	contentType: string;
	contentLength: number;
	title: string;
	description: string;
	content: string | null;
	mainContent: string;
	wordCount: number;
	readingTime: number;
	language: string;
	mediaCount: number;
	discoveredLinkCount: number;
}

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

type CommitCompletedItemResultBase = {
	counters: CrawlCounters;
	effects: TerminalCounterEffects;
	chargedDomain: string | null;
};

export type CommitCompletedItemResult = CommitCompletedItemResultBase &
	({ type: "page-persisted"; pageId: number; pageCount: number } | { type: "no-page" });

export interface TerminalUrlRecord {
	url: string;
	outcome: TerminalOutcome;
	domainBudgetCharged: boolean;
	chargedDomain: string | null;
}

export function createCrawlItemPersistence(db: Database, own: OwnStatement) {
	const insertPage = own(
		db.prepare(`
		INSERT INTO pages (
			crawl_id,
			url,
			domain,
			content_type,
			title,
			description,
			content,
			main_content,
			word_count,
			reading_time,
			language
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING id
	`),
	);

	function insertCompletedPage(
		crawlId: string,
		url: string,
		domain: string,
		page: CompletedPageData,
	): number {
		const pageRow = insertPage.get(
			crawlId,
			url,
			domain,
			page.contentType,
			page.title,
			page.description,
			page.content,
			page.mainContent,
			page.wordCount,
			page.readingTime,
			page.language,
		) as { id: number };
		return pageRow.id;
	}
	const insertTerminal = own(
		db.prepare(`
		INSERT INTO crawl_terminal_urls (
				crawl_id,
				url,
				outcome,
				domain_budget_charged,
				charged_domain
			) VALUES (?, ?, ?, ?, ?)
	`),
	);

	const takeQueueItem = own(
		db.prepare<{ domain: string }, [string, string]>(
			"DELETE FROM crawl_queue_items WHERE crawl_id = ? AND url = ? RETURNING domain",
		),
	);

	const updateProgress = own(
		db.prepare(`
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
	`),
	);
	const countPages = own(
		db.prepare<{ count: number }, [string]>(
			"SELECT COUNT(*) AS count FROM pages WHERE crawl_id = ?",
		),
	);
	const getRunCounters = own(
		db.prepare<
			{
				status: Parameters<typeof isActiveCrawlStatus>[0];
				pages_scanned: number;
				success_count: number;
				failure_count: number;
				skipped_count: number;
				links_found: number;
				media_files: number;
				total_data_bytes: number;
			},
			[string]
		>(`
		SELECT status, pages_scanned, success_count, failure_count, skipped_count,
			links_found, media_files, total_data_bytes
		FROM crawl_runs
		WHERE id = ?
		LIMIT 1
	`),
	);

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
			const pageId = input.page
				? insertCompletedPage(input.crawlId, input.url, queueItem.domain, input.page)
				: undefined;
			const effects: TerminalCounterEffects = input.page
				? {
						dataKb: bytesToKilobytes(input.page.contentLength),
						mediaFiles: input.page.mediaCount,
						discoveredLinks: input.page.discoveredLinkCount,
					}
				: {};
			const counters = deriveTerminalCounters(
				{
					pagesScanned: run.pages_scanned,
					successCount: run.success_count,
					failureCount: run.failure_count,
					skippedCount: run.skipped_count,
					linksFound: run.links_found,
					mediaFiles: run.media_files,
					totalDataKb: bytesToKilobytes(run.total_data_bytes),
				},
				input.outcome,
				effects,
			);

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

			if (pageId === undefined) {
				return {
					type: "no-page",
					counters,
					effects,
					chargedDomain,
				};
			}
			const pageCount = countPages.get(input.crawlId)?.count;
			if (pageCount === undefined || pageCount < 1) {
				throw new Error("Persisted page completion did not produce a positive page count");
			}

			return {
				type: "page-persisted",
				pageId,
				pageCount,
				counters,
				effects,
				chargedDomain,
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
						SELECT url, outcome, domain_budget_charged, charged_domain
						FROM crawl_terminal_urls
						WHERE crawl_id = ?
						ORDER BY terminal_sequence ASC
					`,
				)
				.all(crawlId) as Array<{
				url: string;
				outcome: TerminalOutcome;
				domain_budget_charged: number;
				charged_domain: string | null;
			}>;
			return rows.map((row) => ({
				url: row.url,
				outcome: row.outcome,
				domainBudgetCharged: row.domain_budget_charged === 1,
				chargedDomain: row.charged_domain,
			}));
		},
	};
}
