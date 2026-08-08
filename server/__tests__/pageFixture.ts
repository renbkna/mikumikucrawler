import type { Storage } from "../storage/db.js";
import type { CompletedPageData } from "../storage/repos/crawlItemPersistence.js";

export interface PageFixtureInput extends CompletedPageData {
	crawlId: string;
	url: string;
	domain: string;
}

export type PageFixtureOverrides = Pick<PageFixtureInput, "crawlId" | "url"> &
	Partial<Omit<PageFixtureInput, "crawlId" | "url">>;

export function createPageFixture(input: PageFixtureOverrides): PageFixtureInput {
	const { crawlId, url, ...overrides } = input;
	const content = overrides.content ?? null;
	return {
		crawlId,
		url,
		domain: new URL(url).hostname,
		contentType: "text/html",
		contentLength: content === null ? 0 : Buffer.byteLength(content),
		title: "",
		description: "",
		content,
		mainContent: "",
		wordCount: 0,
		readingTime: 0,
		language: "unknown",
		mediaCount: 0,
		discoveredLinkCount: 0,
		...overrides,
	};
}

/**
 * Persist a page fixture through the same item-completion contract used by the
 * runtime. Tests must not reintroduce a second application-facing page writer.
 */
export function persistPageFixture(storage: Storage, overrides: PageFixtureOverrides): number {
	const input = createPageFixture(overrides);
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
		eventSequence: crawl.eventSequence + 1,
	});

	if (result.type !== "page-persisted") {
		throw new Error("Page fixture did not produce a persisted page identity");
	}
	return result.pageId;
}
