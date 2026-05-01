import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../config/logging.js";
import type { QueueItem } from "../../domain/crawl/CrawlQueue.js";
import { CrawlItemExecutor } from "../CrawlItemExecutor.js";

const item: QueueItem = {
	url: "https://example.com/failing",
	domain: "example.com",
	depth: 0,
	retries: 0,
};

function createLogger(): Logger {
	return {
		level: "info",
		info: mock(() => undefined),
		warn: mock(() => undefined),
		error: mock(() => undefined),
		debug: mock(() => undefined),
		fatal: mock(() => undefined),
		trace: mock(() => undefined),
		silent: mock(() => undefined),
		child: mock(() => createLogger()),
	} as unknown as Logger;
}

function createExecutor(recordTerminalResult: boolean) {
	const process = mock(async () => {
		throw new Error("fetch failed");
	});
	const recordTerminal = mock(() => recordTerminalResult);
	const recordDomainPage = mock(() => undefined);
	const log = mock(() => undefined);

	const executor = new CrawlItemExecutor({
		pipeline: { process } as never,
		state: {
			recordTerminal,
			recordDomainPage,
		} as never,
		logger: createLogger(),
		log,
	});

	return {
		executor,
		process,
		recordTerminal,
		recordDomainPage,
		log,
	};
}

describe("crawl item executor contract", () => {
	test("thrown terminal failures charge domain budget when first recorded", async () => {
		const { executor, recordTerminal, recordDomainPage, log } =
			createExecutor(true);

		const result = await executor.execute(item);

		expect(result).toEqual({
			terminalOutcome: "failure",
			domainBudgetCharged: true,
		});
		expect(recordTerminal).toHaveBeenCalledWith(item.url, "failure");
		expect(recordDomainPage).toHaveBeenCalledWith(item.domain);
		expect(log).toHaveBeenCalledWith(`[Crawler] Failure: ${item.url}`);
	});

	test("duplicate thrown failures do not double-charge domain budget", async () => {
		const { executor, recordDomainPage } = createExecutor(false);

		const result = await executor.execute(item);

		expect(result).toEqual({
			terminalOutcome: "failure",
			domainBudgetCharged: false,
		});
		expect(recordDomainPage).not.toHaveBeenCalled();
	});

	test("processing timeouts abort the item and record one terminal failure", async () => {
		let observedSignal: AbortSignal | undefined;
		const process = mock((_item: QueueItem, signal: AbortSignal) => {
			observedSignal = signal;
			return new Promise(() => undefined);
		});
		const recordTerminal = mock(() => true);
		const recordDomainPage = mock(() => undefined);
		const log = mock(() => undefined);
		const executor = new CrawlItemExecutor({
			pipeline: { process } as never,
			state: {
				recordTerminal,
				recordDomainPage,
			} as never,
			logger: createLogger(),
			log,
			processingTimeoutMs: 5,
		});

		const result = await executor.execute(item);

		expect(result).toEqual({
			terminalOutcome: "failure",
			domainBudgetCharged: true,
		});
		expect(process).toHaveBeenCalledWith(item, expect.any(AbortSignal));
		expect(observedSignal?.aborted).toBe(true);
		expect(recordTerminal).toHaveBeenCalledTimes(1);
		expect(recordDomainPage).toHaveBeenCalledWith(item.domain);
	});
});
