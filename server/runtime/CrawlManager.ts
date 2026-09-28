import type {
	CrawlCounters,
	CrawlOptions,
	CrawlStatus,
	CrawlSummary,
	StopCrawlMode,
} from "../../shared/contracts/index.js";
import {
	crawlOptionsEqual,
	isActiveCrawlStatus,
	isResumableCrawlStatus,
	isTerminalCrawlStatus,
} from "../../shared/contracts/index.js";
import type { Logger } from "../config/logging.js";
import { CRAWL_QUEUE_CONSTANTS } from "../constants.js";
import type { DomainStateRecord } from "../domain/crawl/CrawlState.js";
import { RobotsService } from "../domain/crawl/RobotsService.js";
import type { HttpClient } from "../outbound/HttpClient.js";
import type { DurableStorageBudget } from "../storage/DurableStorageBudget.js";
import type { StorageRepos } from "../storage/db.js";
import { getErrorMessage } from "../utils/helpers.js";
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
	| { type: "not-resumable"; crawl: CrawlSummary }
	| { type: "already-active"; crawl: CrawlSummary }
	| { type: "resumed"; crawl: CrawlSummary };

export type StopCrawlResult =
	| { type: "not-found" }
	| { type: "not-active"; crawl: CrawlSummary }
	| { type: "stopped"; crawl: CrawlSummary };

export type DeleteCrawlResult =
	| { type: "not-found" }
	| { type: "active"; crawl: CrawlSummary }
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

	/** Reserves durable capacity for the pages a crawl may still store. */
	private reserveStorage(
		crawlId: string,
		options: CrawlOptions,
		pagesScanned: number,
		establish?: () => void,
	): void {
		this.deps.storageBudget.reserve(
			crawlId,
			{ maxPages: options.maxPages, pagesScanned },
			establish,
		);
	}

	/**
	 * Reserves capacity and establishes a runtime in one storage transaction, then
	 * starts it. Any failure releases the reservation and the runtime.
	 */
	private admitRuntime(
		crawlId: string,
		options: CrawlOptions,
		pagesScanned: number,
		establish: () => { owner: RuntimeOwner; rollback?: () => void },
	): void {
		let admitted: ReturnType<typeof establish> | undefined;
		try {
			this.reserveStorage(crawlId, options, pagesScanned, () => {
				admitted = establish();
			});
			admitted?.owner.start();
		} catch (error) {
			try {
				admitted?.owner.discard();
				admitted?.rollback?.();
			} finally {
				this.deps.storageBudget.release(crawlId);
			}
			throw error;
		}
	}

	private assertRuntimeCapacity(): void {
		if (this.runtimes.size >= CRAWL_QUEUE_CONSTANTS.MAX_ACTIVE_RUNTIMES) {
			throw new CrawlRuntimeCapacityError();
		}
	}

	/** True while a runtime publishes events for the crawl. */
	hasLiveRuntime(crawlId: string): boolean {
		return this.runtimes.has(crawlId);
	}

	get activeRuntimeCount(): number {
		return this.runtimes.size;
	}

	recoverOrphanedActiveCrawls(): void {
		for (const crawl of this.deps.repos.crawlRuns.listActive()) {
			if (this.runtimes.has(crawl.id)) {
				continue;
			}

			const forceStopping = crawl.status === "stopping";
			this.deps.repos.crawlRuns.transition(crawl.id, forceStopping ? "stopped" : "interrupted", {
				stopReason:
					crawl.stopReason ??
					(forceStopping
						? "Force stop completed during process recovery"
						: "Runtime interrupted by process restart"),
				eventSequence: crawl.eventSequence,
			});
		}
	}

	private createRuntime(
		crawlId: string,
		options: CrawlOptions,
		config: {
			resume: boolean;
			/** The last durable event sequence; the runtime continues numbering after it. */
			eventSequence: number;
			initialCounters?: CrawlCounters;
			initialStartedAtMs?: number;
			initialDomainStates?: DomainStateRecord[];
		},
	): RuntimeOwner {
		const owner = Symbol(crawlId);
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
			// Subscribers exist only while a runtime publishes; a settled crawl is read from snapshots.
			this.deps.eventStream.closeCrawl(crawlId);
		};
		runtime = new CrawlRuntime({
			crawlId,
			options,
			logger: this.deps.logger,
			repos: this.deps.repos,
			reserveStorage: (pagesScanned) => this.reserveStorage(crawlId, options, pagesScanned),
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
			eventSequence: config.eventSequence,
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
							this.deps.repos.crawlRuns.transition(crawlId, "interrupted", {
								stopReason: `Runtime settlement failed: ${getErrorMessage(error)}`,
								eventSequence: runtime.eventSequence,
							});
						}
						releaseOwnership();
					} catch (recoveryError) {
						// ponytail: keep the failed runtime as the in-process owner when SQLite
						// cannot persist containment; process restart owns durable orphan recovery.
						this.deps.logger.error(
							`[Runtime] Failed to quarantine ${crawlId}; retaining ownership until process restart: ${getErrorMessage(recoveryError)}`,
						);
					}
				});
			},
		};
	}

	create(crawlId: string, options: CrawlOptions): CrawlSummary {
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

		this.admitRuntime(crawlId, options, 0, () => {
			const record = this.deps.repos.crawlRuns.createRun(crawlId, options);
			return {
				owner: this.createRuntime(crawlId, record.options, {
					resume: false,
					eventSequence: record.eventSequence,
				}),
				rollback: () => this.deps.repos.crawlRuns.deleteRun(crawlId),
			};
		});
		const created = this.deps.repos.crawlRuns.getById(crawlId);
		if (!created) throw new Error(`Created crawl ${crawlId} is missing`);
		return created;
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
		this.assertRuntimeCapacity();
		this.admitRuntime(crawlId, record.options, record.counters.pagesScanned, () => ({
			owner: this.createRuntime(crawlId, record.options, {
				resume: true,
				eventSequence: record.eventSequence,
				initialCounters: record.counters,
				initialStartedAtMs: record.startedAt === null ? undefined : Date.parse(record.startedAt),
				initialDomainStates: this.deps.repos.crawlDomainState.listByCrawlId(crawlId),
			}),
		}));
		return {
			type: "resumed",
			crawl: this.deps.repos.crawlRuns.getById(crawlId) ?? record,
		};
	}

	get(crawlId: string) {
		return this.deps.repos.crawlRuns.getById(crawlId);
	}

	list(filters: { status?: CrawlStatus; from?: string; to?: string; limit: number }) {
		return this.deps.repos.crawlRuns.list(filters);
	}

	listResumable(limit: number) {
		return this.deps.repos.crawlRuns.listResumable(limit);
	}

	delete(crawlId: string): DeleteCrawlResult {
		const record = this.deps.repos.crawlRuns.getById(crawlId);
		if (!record) return { type: "not-found" };
		if (this.runtimes.has(crawlId) || isActiveCrawlStatus(record.status)) {
			return { type: "active", crawl: record };
		}

		this.deps.repos.crawlRuns.deleteRun(crawlId);
		this.deps.storageBudget.release(crawlId);
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
