import type { Logger } from "../config/logging.js";
import type {
	CrawlCounters,
	CrawlOptions,
	CrawlStatus,
	StopCrawlMode,
} from "../../shared/contracts/index.js";
import {
	DEFAULT_CRAWL_LIST_LIMIT,
	isActiveCrawlStatus,
	isCrawlOptions,
	isResumableCrawlStatus,
	isTerminalCrawlStatus,
} from "../../shared/contracts/index.js";
import type { HttpClient, Resolver } from "../plugins/security.js";
import type { CrawlRunRecord } from "../storage/db.js";
import type { StorageRepos } from "../storage/db.js";
import type { CrawlRuntime } from "./CrawlRuntime.js";
import type { DomainStateRecord } from "../domain/crawl/CrawlState.js";
import { createCrawlRuntime } from "./CrawlRuntimeFactory.js";
import type { EventStream } from "./EventStream.js";
import type { RuntimeRegistry } from "./RuntimeRegistry.js";

interface CreateCrawlManagerOptions {
	logger: Logger;
	repos: StorageRepos;
	eventStream: EventStream;
	registry: RuntimeRegistry;
	resolver: Resolver;
	httpClient: HttpClient;
}

export type ResumeCrawlResult =
	| { type: "not-found" }
	| { type: "not-resumable"; crawl: CrawlRunRecord }
	| { type: "already-running"; crawl: CrawlRunRecord }
	| { type: "resumed"; crawl: CrawlRunRecord };

export type StopCrawlResult =
	| { type: "not-found" }
	| { type: "not-active"; crawl: CrawlRunRecord }
	| { type: "stopped"; crawl: CrawlRunRecord };

export type DeleteCrawlResult =
	| { type: "not-found" }
	| { type: "active"; crawl: CrawlRunRecord }
	| { type: "deleted" };

export class CrawlManager {
	constructor(private readonly deps: CreateCrawlManagerOptions) {
		this.recoverOrphanedActiveCrawls();
	}

	private recoverOrphanedActiveCrawls(): void {
		for (const crawl of this.deps.repos.crawlRuns.listActive()) {
			if (this.deps.registry.get(crawl.id)) {
				continue;
			}

			this.deps.repos.crawlRuns.markInterrupted(
				crawl.id,
				crawl.counters,
				crawl.stopReason ?? "Runtime interrupted by process restart",
				crawl.eventSequence,
			);
		}
	}

	private createRuntime(
		crawlId: string,
		options: CrawlOptions,
		config: {
			resume: boolean;
			initialSequence?: number;
			initialCounters?: CrawlCounters;
			initialStartedAtMs?: number;
			initialDomainStates?: DomainStateRecord[];
		} = { resume: false },
	): CrawlRuntime {
		return createCrawlRuntime({
			crawlId,
			options,
			logger: this.deps.logger,
			repos: this.deps.repos,
			eventStream: this.deps.eventStream,
			resolver: this.deps.resolver,
			httpClient: this.deps.httpClient,
			initialSequence: config.initialSequence,
			initialCounters: config.initialCounters,
			initialStartedAtMs: config.initialStartedAtMs,
			initialDomainStates: config.initialDomainStates,
			resume: config.resume,
			registry: this.deps.registry,
		});
	}

	create(options: CrawlOptions) {
		const crawlId = crypto.randomUUID();
		const record = this.deps.repos.crawlRuns.createRun(
			crawlId,
			options.target,
			options,
		);
		const runtime = this.createRuntime(crawlId, options);
		void runtime.start();
		return this.deps.repos.crawlRuns.getById(crawlId) ?? record;
	}

	async stop(
		crawlId: string,
		mode: StopCrawlMode = "pause",
	): Promise<StopCrawlResult> {
		const record = this.deps.repos.crawlRuns.getById(crawlId);
		if (!record) return { type: "not-found" };
		if (isTerminalCrawlStatus(record.status)) {
			return { type: "stopped", crawl: record };
		}
		if (!isActiveCrawlStatus(record.status)) {
			return { type: "not-active", crawl: record };
		}

		const runtime = this.deps.registry.get(crawlId);
		if (!runtime) {
			return { type: "not-active", crawl: record };
		}

		if (mode === "force") {
			await runtime.requestForceStop();
		} else {
			await runtime.requestPause();
		}

		return {
			type: "stopped",
			crawl: this.deps.repos.crawlRuns.getById(crawlId) ?? record,
		};
	}

	resume(crawlId: string): ResumeCrawlResult {
		const record = this.deps.repos.crawlRuns.getById(crawlId);
		if (!record) return { type: "not-found" };
		if (!isResumableCrawlStatus(record.status)) {
			return { type: "not-resumable", crawl: record };
		}
		if (!isCrawlOptions(record.options)) {
			return { type: "not-resumable", crawl: record };
		}
		if (this.deps.registry.get(crawlId)) {
			return { type: "already-running", crawl: record };
		}

		this.deps.eventStream.reset(crawlId, record.eventSequence);
		const runtime = this.createRuntime(crawlId, record.options, {
			resume: true,
			initialSequence: record.eventSequence,
			initialCounters: record.counters,
			initialStartedAtMs:
				record.startedAt === null ? undefined : Date.parse(record.startedAt),
			initialDomainStates:
				this.deps.repos.crawlDomainState.listByCrawlId(crawlId),
		});
		this.deps.repos.crawlRuns.markStarting(
			crawlId,
			record.counters,
			record.eventSequence,
		);
		void runtime.start();
		return {
			type: "resumed",
			crawl: this.deps.repos.crawlRuns.getById(crawlId) ?? record,
		};
	}

	get(crawlId: string) {
		return this.deps.repos.crawlRuns.getById(crawlId);
	}

	list(filters: {
		status?: CrawlStatus;
		from?: string;
		to?: string;
		limit?: number;
	}) {
		return this.deps.repos.crawlRuns.list(filters);
	}

	listResumable(limit?: number) {
		const effectiveLimit = limit ?? DEFAULT_CRAWL_LIST_LIMIT;
		return this.deps.repos.crawlRuns
			.getResumableRuns(effectiveLimit + this.deps.registry.size())
			.filter((crawl) => !this.deps.registry.get(crawl.id))
			.slice(0, effectiveLimit);
	}

	delete(crawlId: string): DeleteCrawlResult {
		const record = this.deps.repos.crawlRuns.getById(crawlId);
		if (!record) return { type: "not-found" };
		if (this.deps.registry.get(crawlId) || isActiveCrawlStatus(record.status)) {
			return { type: "active", crawl: record };
		}

		this.deps.repos.crawlRuns.deleteRun(crawlId);
		this.deps.eventStream.delete(crawlId);
		return { type: "deleted" };
	}

	async shutdownAll(): Promise<void> {
		const runtimes = [...this.deps.registry.values()];
		const interruptions: Promise<void>[] = [];
		for (const runtime of runtimes) {
			interruptions.push(runtime.interrupt("Process shutdown"));
		}

		await Promise.allSettled(interruptions);
		await Promise.allSettled(
			runtimes.map((runtime) => runtime.waitUntilSettled()),
		);
	}
}
