import type { Storage } from "../storage/db.js";
import type { CompletedPageData } from "../storage/repos/crawlItemPersistence.js";

export interface PageFixtureInput extends CompletedPageData {
	crawlId: string;
	url: string;
	domain: string;
}

/**
 * Persist a page fixture through the same item-completion contract used by the
 * runtime. Tests must not reintroduce a second application-facing page writer.
 */
export function persistPageFixture(storage: Storage, input: PageFixtureInput): number {
	const crawl = storage.repos.crawlRuns.getById(input.crawlId);
	if (!crawl) {
		throw new Error(`Page fixture crawl ${input.crawlId} does not exist`);
	}

	const { crawlId, url, domain, ...page } = input;
	if (!storage.repos.crawlQueue.listPending(crawlId).some((item) => item.url === url)) {
		storage.repos.crawlQueue.enqueueMany(crawlId, [
			{
				url,
				depth: 0,
				retries: 0,
				domain,
			},
		]);
	}
	const result = storage.repos.crawlItems.commitCompletedItem({
		crawlId,
		url,
		outcome: "success",
		domainBudgetCharged: true,
		page,
		counters: {
			...crawl.counters,
			pagesScanned: crawl.counters.pagesScanned + 1,
			successCount: crawl.counters.successCount + 1,
		},
		eventSequence: crawl.eventSequence + 1,
	});

	if (result.type !== "page-persisted") {
		throw new Error("Page fixture did not produce a persisted page identity");
	}
	return result.pageId;
}
