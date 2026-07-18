import type { Database } from "bun:sqlite";
import type { CrawlCounters } from "../../../shared/contracts/index.js";
import type { ExtractedLink } from "../../../shared/types.js";
import type { TerminalOutcome } from "../../domain/crawl/CrawlState.js";
import type { ProcessedContent } from "../../types.js";

export interface CompletedPageData {
	contentType: string;
	statusCode: number;
	contentLength: number;
	title: string;
	description: string;
	content: string | null;
	isDynamic: boolean;
	lastModified: string | null;
	etag: string | null;
	processedContent: ProcessedContent;
	links: ExtractedLink[];
}

interface CommitCompletedItemBase {
	crawlId: string;
	url: string;
	domainBudgetCharged: boolean;
	counters: CrawlCounters;
	eventSequence: number;
}

export type CommitCompletedItemInput = CommitCompletedItemBase &
	(
		| { outcome: "success"; page: CompletedPageData }
		| { outcome: Exclude<TerminalOutcome, "success">; page?: never }
	);

export type CommitCompletedItemResult =
	| { type: "page-persisted"; pageId: number; pageCount: number }
	| { type: "no-page" };

export interface TerminalUrlRecord {
	url: string;
	outcome: TerminalOutcome;
	domainBudgetCharged: boolean;
}

export function createCrawlItemPersistence(db: Database) {
	const insertPage = db.prepare(`
		INSERT INTO pages (
			crawl_id,
			url,
			domain,
			content_type,
			status_code,
			data_length,
			title,
			description,
			content,
			is_dynamic,
			last_modified,
			etag,
			main_content,
			word_count,
			reading_time,
			language,
			keywords,
			quality_score,
			structured_data,
			media_count,
			internal_links_count,
			external_links_count,
			discovered_links_count
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING id
	`);
	const insertLink = db.prepare(
		"INSERT OR IGNORE INTO page_links (page_id, target_url, text, nofollow) VALUES (?, ?, ?, ?)",
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
			page.statusCode,
			page.contentLength,
			page.title,
			page.description,
			page.content,
			page.isDynamic ? 1 : 0,
			page.lastModified,
			page.etag,
			page.processedContent.extractedData?.mainContent ?? "",
			page.processedContent.analysis?.wordCount ?? 0,
			page.processedContent.analysis?.readingTime ?? 0,
			page.processedContent.analysis?.language ?? "unknown",
			JSON.stringify(page.processedContent.analysis?.keywords ?? []),
			page.processedContent.analysis?.quality?.score ?? 0,
			JSON.stringify(page.processedContent.extractedData ?? {}),
			page.processedContent.media?.length ?? 0,
			page.links.filter((link) => link.isInternal).length,
			page.links.filter((link) => !link.isInternal).length,
			page.processedContent.links?.length ?? page.links.length,
		) as { id: number };

		for (const link of page.links) {
			insertLink.run(pageRow.id, link.url, link.text ?? "", link.nofollow ? 1 : 0);
		}

		return pageRow.id;
	}
	const insertTerminal = db.prepare(`
		INSERT INTO crawl_terminal_urls (
				crawl_id,
				url,
				outcome,
				domain_budget_charged
			) VALUES (?, ?, ?, ?)
	`);

	const takeQueueItem = db.prepare<{ domain: string }, [string, string]>(
		"DELETE FROM crawl_queue_items WHERE crawl_id = ? AND url = ? RETURNING domain",
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
	const countPages = db.prepare<{ count: number }, [string]>(
		"SELECT COUNT(*) AS count FROM pages WHERE crawl_id = ?",
	);

	const commitCompletedTransaction = db.transaction(
		(input: CommitCompletedItemInput): CommitCompletedItemResult => {
			const queueItem = takeQueueItem.get(input.crawlId, input.url);
			if (!queueItem) {
				throw new Error(`Cannot complete non-pending crawl URL: ${input.url}`);
			}
			insertTerminal.run(
				input.crawlId,
				input.url,
				input.outcome,
				input.domainBudgetCharged ? 1 : 0,
			);
			const pageId = input.page
				? insertCompletedPage(input.crawlId, input.url, queueItem.domain, input.page)
				: undefined;

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

			if (pageId === undefined) {
				return { type: "no-page" };
			}
			const pageCount = countPages.get(input.crawlId)?.count;
			if (pageCount === undefined || pageCount < 1) {
				throw new Error("Persisted page completion did not produce a positive page count");
			}

			return {
				type: "page-persisted",
				pageId,
				pageCount,
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
