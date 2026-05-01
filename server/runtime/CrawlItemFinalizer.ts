import type { CrawlPagePayload } from "../../shared/contracts/events.js";
import type { QueueItem } from "../domain/crawl/CrawlQueue.js";
import type { CrawlState } from "../domain/crawl/CrawlState.js";
import type { PageProcessResult } from "../domain/crawl/PagePipeline.js";
import type { StorageRepos } from "../storage/db.js";
import type { CrawlQueue } from "../domain/crawl/CrawlQueue.js";
import type { EventStream } from "./EventStream.js";

export interface CrawlItemFinalizerDependencies {
	crawlId: string;
	state: CrawlState;
	queue: CrawlQueue;
	repos: StorageRepos;
	eventStream: EventStream;
	getCurrentSequence: () => number;
}

export interface FinalizeCrawlItemOptions {
	interrupted: boolean;
}

export class CrawlItemFinalizer {
	constructor(private readonly deps: CrawlItemFinalizerDependencies) {}

	finalize(
		item: QueueItem,
		processResult: PageProcessResult,
		options: FinalizeCrawlItemOptions,
	): void {
		if (processResult.aborted) {
			this.deps.queue.markDone(item, { persist: false });
			return;
		}

		if (processResult.rescheduled) {
			this.deps.queue.markDone(item);
			return;
		}

		if (
			options.interrupted &&
			!processResult.terminalOutcome &&
			!processResult.page
		) {
			this.deps.queue.markInterrupted(item);
			return;
		}

		const pendingPageEvent = processResult.page ? 1 : 0;
		const itemCommit = this.deps.repos.crawlItems.commitCompletedItem({
			crawlId: this.deps.crawlId,
			url: item.url,
			outcome: processResult.terminalOutcome,
			domainBudgetCharged: processResult.domainBudgetCharged ?? false,
			page: processResult.page?.saveInput,
			counters: this.deps.state.snapshotCounters(),
			eventSequence: this.deps.getCurrentSequence() + pendingPageEvent,
		});

		if (processResult.page) {
			this.publishPage({
				...processResult.page.eventPayload,
				id: itemCommit.pageId ?? null,
			});
		}

		this.deps.queue.markDone(item, { persist: false });
	}

	private publishPage(payload: CrawlPagePayload): void {
		this.deps.eventStream.publish(this.deps.crawlId, "crawl.page", payload);
	}
}
