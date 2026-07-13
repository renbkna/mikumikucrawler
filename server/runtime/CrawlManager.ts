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
import type { Logger } from "../config/logging.js";
import type { DomainStateRecord } from "../domain/crawl/CrawlState.js";
import type { HttpClient, Resolver } from "../plugins/security.js";
import type { CrawlRunRecord, StorageRepos } from "../storage/db.js";
import { CrawlRuntime } from "./CrawlRuntime.js";
import type { EventStream } from "./EventStream.js";

interface CreateCrawlManagerOptions {
	logger: Logger;
	repos: StorageRepos;
	eventStream: EventStream;
	registry: Map<string, CrawlRuntime>;
	resolver: Resolver;
	httpClient: HttpClient;
	allowLocalhostSeed?: boolean;
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

export class CrawlManagerClosingError extends Error {
	constructor() {
		super("Crawl service is shutting down");
		this.name = "CrawlManagerClosingError";
	}
}

export class CrawlManager {
	private closing = false;

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
		const runtime = new CrawlRuntime({
			crawlId,
			options,
			logger: this.deps.logger,
			repos: this.deps.repos,
			eventStream: this.deps.eventStream,
			resolver: this.deps.resolver,
			httpClient: this.deps.httpClient,
			allowLocalhostSeed: this.deps.allowLocalhostSeed ?? false,
			...(config.initialSequence !== undefined ? { initialSequence: config.initialSequence } : {}),
			...(config.initialCounters !== undefined ? { initialCounters: config.initialCounters } : {}),
			...(config.initialStartedAtMs !== undefined
				? { initialStartedAtMs: config.initialStartedAtMs }
				: {}),
			...(config.initialDomainStates !== undefined
				? { initialDomainStates: config.initialDomainStates }
				: {}),
			resume: config.resume,
			onInactive: () => {
				this.deps.registry.delete(crawlId);
			},
			onSettled: () => {
				this.deps.eventStream.scheduleCleanup(crawlId);
			},
		});
		this.deps.registry.set(crawlId, runtime);
		return runtime;
	}

	create(options: CrawlOptions) {
		if (this.closing) {
			throw new CrawlManagerClosingError();
		}

		const crawlId = crypto.randomUUID();
		const record = this.deps.repos.crawlRuns.createRun(crawlId, options);
		const runtime = this.createRuntime(crawlId, record.options);
		void runtime.start();
		return this.deps.repos.crawlRuns.getById(crawlId) ?? record;
	}

	async stop(crawlId: string, mode: StopCrawlMode = "pause"): Promise<StopCrawlResult> {
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

		this.deps.repos.crawlRuns.markStarting(crawlId, record.counters, record.eventSequence);
		this.deps.eventStream.reset(crawlId, record.eventSequence);
		let runtime: CrawlRuntime;
		try {
			runtime = this.createRuntime(crawlId, record.options, {
				resume: true,
				initialSequence: record.eventSequence,
				initialCounters: record.counters,
				initialStartedAtMs: record.startedAt === null ? undefined : Date.parse(record.startedAt),
				initialDomainStates: this.deps.repos.crawlDomainState.listByCrawlId(crawlId),
			});
		} catch (error) {
			this.deps.repos.crawlRuns.markInterrupted(
				crawlId,
				record.counters,
				"Resume startup failed before runtime ownership was established",
				record.eventSequence,
			);
			throw error;
		}
		void runtime.start();
		return {
			type: "resumed",
			crawl: this.deps.repos.crawlRuns.getById(crawlId) ?? record,
		};
	}

	get(crawlId: string) {
		return this.deps.repos.crawlRuns.getById(crawlId);
	}

	list(filters: { status?: CrawlStatus; from?: string; to?: string; limit?: number }) {
		return this.deps.repos.crawlRuns.list(filters);
	}

	listResumable(limit?: number) {
		const effectiveLimit = limit ?? DEFAULT_CRAWL_LIST_LIMIT;
		return this.deps.repos.crawlRuns
			.getResumableRuns(effectiveLimit + this.deps.registry.size)
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
		this.closing = true;
		const runtimes = [...this.deps.registry.values()];
		const interruptions: Promise<void>[] = [];
		for (const runtime of runtimes) {
			interruptions.push(runtime.interrupt("Process shutdown"));
		}

		await Promise.allSettled(interruptions);
		await Promise.allSettled(runtimes.map((runtime) => runtime.waitUntilSettled()));
	}
}
