import { CRAWL_QUEUE_CONSTANTS } from "../constants.js";
import type { Logger } from "../config/logging.js";
import type { QueueItem } from "../domain/crawl/CrawlQueue.js";
import type { CrawlState } from "../domain/crawl/CrawlState.js";
import type {
	PagePipeline,
	PageProcessResult,
} from "../domain/crawl/PagePipeline.js";
import { runWithTimeout } from "../utils/timeout.js";

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
		try {
			return await runWithTimeout({
				timeoutMs:
					this.deps.processingTimeoutMs ??
					CRAWL_QUEUE_CONSTANTS.ITEM_PROCESSING_TIMEOUT_MS,
				operationName: `Processing ${item.url}`,
				signal: externalSignal,
				run: (signal) => this.deps.pipeline.process(item, signal),
			});
		} catch (error) {
			if (externalSignal?.aborted) {
				return { aborted: true };
			}

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
