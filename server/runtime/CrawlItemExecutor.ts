import { CRAWL_QUEUE_CONSTANTS } from "../constants.js";
import type { Logger } from "../config/logging.js";
import type { QueueItem } from "../domain/crawl/CrawlQueue.js";
import type { CrawlState } from "../domain/crawl/CrawlState.js";
import type {
	PagePipeline,
	PageProcessResult,
} from "../domain/crawl/PagePipeline.js";
import { withTimeout } from "../utils/timeout.js";

export interface CrawlItemExecutorDependencies {
	pipeline: PagePipeline;
	state: CrawlState;
	logger: Logger;
	log: (message: string) => void;
	processingTimeoutMs?: number;
}

export class CrawlItemExecutor {
	constructor(private readonly deps: CrawlItemExecutorDependencies) {}

	async execute(
		item: QueueItem,
		externalSignal?: AbortSignal,
	): Promise<PageProcessResult> {
		const controller = new AbortController();
		const signal = externalSignal
			? AbortSignal.any([externalSignal, controller.signal])
			: controller.signal;
		try {
			return await withTimeout(
				this.deps.pipeline.process(item, signal),
				this.deps.processingTimeoutMs ??
					CRAWL_QUEUE_CONSTANTS.ITEM_PROCESSING_TIMEOUT_MS,
				`Processing ${item.url}`,
			);
		} catch (error) {
			if (externalSignal?.aborted) {
				return { aborted: true };
			}

			controller.abort(error);
			this.deps.logger.error(
				`[Runtime] Failed to process ${item.url}: ${error instanceof Error ? error.message : String(error)}`,
			);
			const domainBudgetCharged = this.deps.state.recordTerminal(
				item.url,
				"failure",
			);
			if (domainBudgetCharged) {
				this.deps.state.recordDomainPage(item.domain);
			}
			this.deps.log(`[Crawler] Failure: ${item.url}`);
			return { terminalOutcome: "failure", domainBudgetCharged };
		}
	}
}
