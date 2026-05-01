import { describe, expect, mock, test } from "bun:test";
import type { CrawlCounters } from "../../../shared/contracts/crawl.js";
import { CrawlItemFinalizer } from "../CrawlItemFinalizer.js";

const item = {
	url: "https://example.com/post",
	domain: "example.com",
	depth: 0,
	retries: 0,
};

const counters: CrawlCounters = {
	pagesScanned: 1,
	successCount: 1,
	failureCount: 0,
	skippedCount: 0,
	linksFound: 2,
	mediaFiles: 0,
	totalDataKb: 4,
};

function createFinalizer(currentSequence = 10) {
	const commitCompletedItem = mock(() => ({ pageId: 42 }));
	const markInterrupted = mock(() => undefined);
	const markDone = mock(() => undefined);
	const publish = mock(() => undefined);

	const finalizer = new CrawlItemFinalizer({
		crawlId: "crawl-1",
		state: {
			snapshotCounters: () => counters,
		} as never,
		queue: {
			markInterrupted,
			markDone,
		} as never,
		repos: {
			crawlItems: {
				commitCompletedItem,
			},
		} as never,
		eventStream: {
			publish,
		} as never,
		getCurrentSequence: () => currentSequence,
	});

	return {
		finalizer,
		commitCompletedItem,
		markInterrupted,
		markDone,
		publish,
	};
}

describe("crawl item finalizer contract", () => {
	test("interrupted unfinished item preserves queue item and does not commit or publish page", () => {
		const {
			finalizer,
			markInterrupted,
			markDone,
			commitCompletedItem,
			publish,
		} = createFinalizer();

		finalizer.finalize(item, {}, { interrupted: true });

		expect(markInterrupted).toHaveBeenCalledWith(item);
		expect(markDone).not.toHaveBeenCalled();
		expect(commitCompletedItem).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});

	test("interrupted completed item still commits terminal state and counters", () => {
		const { finalizer, markInterrupted, markDone, commitCompletedItem } =
			createFinalizer();

		finalizer.finalize(
			item,
			{
				terminalOutcome: "success",
				domainBudgetCharged: true,
			},
			{ interrupted: true },
		);

		expect(markInterrupted).not.toHaveBeenCalled();
		expect(commitCompletedItem).toHaveBeenCalledWith({
			crawlId: "crawl-1",
			url: item.url,
			outcome: "success",
			domainBudgetCharged: true,
			page: undefined,
			counters,
			eventSequence: 10,
		});
		expect(markDone).toHaveBeenCalledWith(item, { persist: false });
	});

	test("aborted item is discarded without dropping already completed results", () => {
		const { finalizer, markDone, commitCompletedItem, publish } =
			createFinalizer();

		finalizer.finalize(item, { aborted: true }, { interrupted: false });

		expect(markDone).toHaveBeenCalledWith(item, { persist: false });
		expect(commitCompletedItem).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});

	test("rescheduled item clears active queue state without deleting retry persistence", () => {
		const { finalizer, markDone, commitCompletedItem, publish } =
			createFinalizer();

		finalizer.finalize(item, { rescheduled: true }, { interrupted: false });

		expect(markDone).toHaveBeenCalledWith(item);
		expect(commitCompletedItem).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});

	test("successful page commit is atomic before publishing crawl.page with persisted id", () => {
		const { finalizer, commitCompletedItem, publish, markDone } =
			createFinalizer();
		const saveInput = {
			crawlId: "crawl-1",
			url: item.url,
			domain: item.domain,
			contentType: "text/html",
			statusCode: 200,
			contentLength: 4096,
			title: "Title",
			description: "Description",
			content: "<main>Body</main>",
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "Body" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		};
		const eventPayload = {
			url: item.url,
			title: "Title",
			description: "Description",
			contentType: "text/html",
			domain: item.domain,
			processedData: {
				extractedData: { mainContent: "Body", jsonLd: [] },
				metadata: {},
				analysis: {},
				media: [],
				errors: [],
				qualityScore: 0,
				language: "unknown",
			},
		};

		finalizer.finalize(
			item,
			{
				terminalOutcome: "success",
				domainBudgetCharged: true,
				page: {
					saveInput,
					eventPayload,
				},
			},
			{ interrupted: false },
		);

		expect(commitCompletedItem).toHaveBeenCalledWith({
			crawlId: "crawl-1",
			url: item.url,
			outcome: "success",
			domainBudgetCharged: true,
			page: saveInput,
			counters,
			eventSequence: 11,
		});
		expect(publish).toHaveBeenCalledWith("crawl-1", "crawl.page", {
			...eventPayload,
			id: 42,
		});
		expect(markDone).toHaveBeenCalledWith(item, { persist: false });
	});

	test("terminal failure commits counters and terminal state without page publish", () => {
		const { finalizer, commitCompletedItem, publish, markDone } =
			createFinalizer();

		finalizer.finalize(
			item,
			{
				terminalOutcome: "failure",
			},
			{ interrupted: false },
		);

		expect(commitCompletedItem).toHaveBeenCalledWith({
			crawlId: "crawl-1",
			url: item.url,
			outcome: "failure",
			domainBudgetCharged: false,
			page: undefined,
			counters,
			eventSequence: 10,
		});
		expect(publish).not.toHaveBeenCalled();
		expect(markDone).toHaveBeenCalledWith(item, { persist: false });
	});

	test("terminal skip commits counters and terminal state without page publish", () => {
		const { finalizer, commitCompletedItem, publish, markDone } =
			createFinalizer();

		finalizer.finalize(
			item,
			{
				terminalOutcome: "skip",
			},
			{ interrupted: false },
		);

		expect(commitCompletedItem).toHaveBeenCalledWith({
			crawlId: "crawl-1",
			url: item.url,
			outcome: "skip",
			domainBudgetCharged: false,
			page: undefined,
			counters,
			eventSequence: 10,
		});
		expect(publish).not.toHaveBeenCalled();
		expect(markDone).toHaveBeenCalledWith(item, { persist: false });
	});

	test("event sequence passed to storage accounts for the pending page event", () => {
		const { finalizer, commitCompletedItem } = createFinalizer(22);

		finalizer.finalize(
			item,
			{
				terminalOutcome: "success",
				page: {
					saveInput: {} as never,
					eventPayload: {
						url: item.url,
					},
				},
			},
			{ interrupted: false },
		);

		expect(commitCompletedItem).toHaveBeenCalledWith(
			expect.objectContaining({
				eventSequence: 23,
			}),
		);
	});
});
