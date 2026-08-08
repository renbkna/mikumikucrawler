import type {
	CrawlCounters,
	CrawlOptions,
	CrawlStatus,
	StopCrawlMode,
} from "../../shared/contracts/index.js";
import {
	crawlOptionsEqual,
	DEFAULT_CRAWL_LIST_LIMIT,
	isActiveCrawlStatus,
	isCrawlOptions,
	isResumableCrawlStatus,
	isTerminalCrawlStatus,
} from "../../shared/contracts/index.js";
import type { Logger } from "../config/logging.js";
import { CRAWL_QUEUE_CONSTANTS } from "../constants.js";
import type { DomainStateRecord } from "../domain/crawl/CrawlState.js";
import { RobotsService } from "../domain/crawl/RobotsService.js";
import type { HttpClient } from "../outbound/HttpClient.js";
import type { DurableStorageBudget } from "../storage/DurableStorageBudget.js";
import type { CrawlRunRecord, StorageRepos } from "../storage/db.js";
import { WorkPermitPool } from "../utils/WorkPermitPool.js";
import { CrawlRuntime } from "./CrawlRuntime.js";
import type { EventStream } from "./EventStream.js";

interface CreateCrawlManagerOptions {
	logger: Logger;
	repos: StorageRepos;
	eventStream: EventStream;
	httpClient: HttpClient;
	storageBudget: DurableStorageBudget;
	allowLocalhostSeed?: boolean;
}

interface RuntimeOwner {
	discard(): void;
	runtime: CrawlRuntime;
	start(): void;
}

export type ResumeCrawlResult =
	| { type: "not-found" }
	| { type: "not-resumable"; crawl: CrawlRunRecord }
	| { type: "already-active"; crawl: CrawlRunRecord }
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

export class CrawlIdentityConflictError extends Error {
	constructor(readonly crawlId: string) {
		super(`Crawl identity ${crawlId} is already bound to different options`);
		this.name = "CrawlIdentityConflictError";
	}
}

export class CrawlRuntimeCapacityError extends Error {
	constructor(readonly limit = CRAWL_QUEUE_CONSTANTS.MAX_ACTIVE_RUNTIMES) {
		super(`Active crawl capacity reached (${limit})`);
		this.name = "CrawlRuntimeCapacityError";
	}
}

export class CrawlManager {
	private closing = false;
	private readonly robotsService: RobotsService;
	private readonly pdfWorkBudget = new WorkPermitPool(1);
	private readonly runtimes = new Map<string, CrawlRuntime>();
	private readonly runtimeOwners = new Map<string, symbol>();

	constructor(private readonly deps: CreateCrawlManagerOptions) {
		this.robotsService = new RobotsService(deps.httpClient, deps.logger);
	}

	private reserveStorage(
		crawlId: string,
		options: CrawlOptions,
		pagesScanned: number,
		establish: () => void,
	): void {
		const reservation = this.deps.storageBudget.reserve(
			crawlId,
			{
				maxPages: options.maxPages,
				pagesScanned,
			},
			establish,
		);
		for (const reclaimedCrawlId of reservation.reclaimedCrawlIds) {
			this.deps.eventStream.delete(reclaimedCrawlId);
		}
	}

	private assertRuntimeCapacity(): void {
		if (this.runtimes.size >= CRAWL_QUEUE_CONSTANTS.MAX_ACTIVE_RUNTIMES) {
			throw new CrawlRuntimeCapacityError();
		}
	}

	get activeRuntimeCount(): number {
		return this.runtimes.size;
	}

	recoverOrphanedActiveCrawls(): void {
		for (const crawl of this.deps.repos.crawlRuns.listActive()) {
			if (this.runtimes.has(crawl.id)) {
				continue;
			}

			if (crawl.status === "stopping") {
				this.deps.repos.crawlRuns.markStopped(
					crawl.id,
					crawl.stopReason ?? "Force stop completed during process recovery",
					crawl.eventSequence,
				);
				continue;
			}

			this.deps.repos.crawlRuns.markInterrupted(
				crawl.id,
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
			eventGeneration: number;
			initialCounters?: CrawlCounters;
			initialStartedAtMs?: number;
			initialDomainStates?: DomainStateRecord[];
		},
	): RuntimeOwner {
		const owner = Symbol(crawlId);
		const eventGeneration = config.eventGeneration;
		let runtime!: CrawlRuntime;
		const releaseRegistry = () => {
			if (this.runtimeOwners.get(crawlId) === owner && this.runtimes.get(crawlId) === runtime) {
				this.runtimes.delete(crawlId);
			}
		};
		const releaseOwnership = () => {
			if (this.runtimeOwners.get(crawlId) !== owner) return;
			releaseRegistry();
			this.runtimeOwners.delete(crawlId);
			this.deps.storageBudget.release(crawlId);
			this.deps.eventStream.scheduleCleanup(crawlId, eventGeneration);
		};
		runtime = new CrawlRuntime({
			crawlId,
			options,
			logger: this.deps.logger,
			repos: this.deps.repos,
			storageBudget: this.deps.storageBudget,
			eventStream: this.deps.eventStream,
			httpClient: this.deps.httpClient,
			robotsService: this.robotsService,
			acquirePdfWork: this.pdfWorkBudget.acquire,
			allowLocalhostSeed: this.deps.allowLocalhostSeed ?? false,
			...(config.initialCounters !== undefined ? { initialCounters: config.initialCounters } : {}),
			...(config.initialStartedAtMs !== undefined
				? { initialStartedAtMs: config.initialStartedAtMs }
				: {}),
			...(config.initialDomainStates !== undefined
				? { initialDomainStates: config.initialDomainStates }
				: {}),
			resume: config.resume,
			onInactive: releaseRegistry,
			onSettled: releaseOwnership,
		});
		this.runtimeOwners.set(crawlId, owner);
		this.runtimes.set(crawlId, runtime);
		return {
			discard: releaseOwnership,
			runtime,
			start: () => {
				void runtime.start().catch((error) => {
					try {
						const persisted = this.deps.repos.crawlRuns.getById(crawlId);
						if (persisted && isActiveCrawlStatus(persisted.status)) {
							const recovered = this.deps.repos.crawlRuns.markInterrupted(
								crawlId,
								`Runtime settlement failed: ${error instanceof Error ? error.message : String(error)}`,
								this.deps.eventStream.getCurrentSequence(crawlId),
							);
							if (!recovered) {
								throw new Error(`Active crawl disappeared during recovery: ${crawlId}`);
							}
						}
						releaseOwnership();
					} catch (recoveryError) {
						// ponytail: keep the failed runtime as the in-process owner when SQLite
						// cannot persist containment; process restart owns durable orphan recovery.
						this.deps.logger.error(
							`[Runtime] Failed to quarantine ${crawlId}; retaining ownership until process restart: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
						);
					}
				});
			},
		};
	}

	create(crawlId: string, options: CrawlOptions): CrawlRunRecord {
		const existing = this.deps.repos.crawlRuns.getById(crawlId);
		if (existing) {
			if (!crawlOptionsEqual(existing.options, options)) {
				throw new CrawlIdentityConflictError(crawlId);
			}
			return existing;
		}
		if (this.closing) {
			throw new CrawlManagerClosingError();
		}
		this.assertRuntimeCapacity();

		let created = false;
		let record!: CrawlRunRecord;
		let runtimeOwner: ReturnType<CrawlManager["createRuntime"]> | undefined;
		try {
			this.reserveStorage(crawlId, options, 0, () => {
				const eventGeneration = this.deps.eventStream.initialize(crawlId);
				record = this.deps.repos.crawlRuns.createRun(crawlId, options);
				created = true;
				runtimeOwner = this.createRuntime(crawlId, record.options, {
					resume: false,
					eventGeneration,
				});
			});
			runtimeOwner?.start();
		} catch (error) {
			try {
				runtimeOwner?.discard();
				if (created) this.deps.repos.crawlRuns.deleteRun(crawlId);
			} finally {
				this.deps.eventStream.delete(crawlId);
				this.deps.storageBudget.release(crawlId);
			}
			throw error;
		}
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

		const runtime = this.runtimes.get(crawlId);
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
		if (this.closing) {
			throw new CrawlManagerClosingError();
		}

		const record = this.deps.repos.crawlRuns.getById(crawlId);
		if (!record) return { type: "not-found" };
		if (this.runtimes.has(crawlId)) {
			return { type: "already-active", crawl: record };
		}
		if (!isResumableCrawlStatus(record.status)) {
			return { type: "not-resumable", crawl: record };
		}
		if (!isCrawlOptions(record.options)) {
			return { type: "not-resumable", crawl: record };
		}
		this.assertRuntimeCapacity();
		let runtimeOwner: ReturnType<CrawlManager["createRuntime"]> | undefined;
		try {
			this.reserveStorage(crawlId, record.options, record.counters.pagesScanned, () => {
				const eventGeneration = this.deps.eventStream.reset(crawlId, record.eventSequence);
				runtimeOwner = this.createRuntime(crawlId, record.options, {
					resume: true,
					eventGeneration,
					initialCounters: record.counters,
					initialStartedAtMs: record.startedAt === null ? undefined : Date.parse(record.startedAt),
					initialDomainStates: this.deps.repos.crawlDomainState.listByCrawlId(crawlId),
				});
			});
			runtimeOwner?.start();
		} catch (error) {
			runtimeOwner?.discard();
			this.deps.eventStream.delete(crawlId);
			this.deps.storageBudget.release(crawlId);
			throw error;
		}
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
		return this.deps.repos.crawlRuns.getResumableRuns(effectiveLimit);
	}

	delete(crawlId: string): DeleteCrawlResult {
		const record = this.deps.repos.crawlRuns.getById(crawlId);
		if (!record) return { type: "not-found" };
		if (this.runtimes.has(crawlId) || isActiveCrawlStatus(record.status)) {
			return { type: "active", crawl: record };
		}

		this.deps.repos.crawlRuns.deleteRun(crawlId);
		this.deps.storageBudget.release(crawlId);
		this.deps.eventStream.delete(crawlId);
		return { type: "deleted" };
	}

	async shutdownAll(): Promise<void> {
		this.closing = true;
		const runtimes = [...this.runtimes.values()];
		const robotsShutdown = this.robotsService.close();
		const interruptions: Promise<void>[] = [];
		for (const runtime of runtimes) {
			interruptions.push(runtime.interrupt("Process shutdown"));
		}

		await Promise.allSettled([robotsShutdown, ...interruptions]);
		await Promise.allSettled(runtimes.map((runtime) => runtime.waitUntilSettled()));
	}
}
