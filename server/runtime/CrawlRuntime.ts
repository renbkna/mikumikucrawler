import type {
	ActiveCrawlStatus,
	CrawlCounters,
	CrawlEventMap,
	CrawlEventType,
	CrawlLogLevel,
	CrawlOptions,
} from "../../shared/contracts/index.js";
import { isActiveCrawlStatus } from "../../shared/contracts/index.js";
import type { Logger } from "../config/logging.js";
import { CRAWL_QUEUE_CONSTANTS } from "../constants.js";
import { CrawlQueue, type QueueItem } from "../domain/crawl/CrawlQueue.js";
import type { DomainStateRecord } from "../domain/crawl/CrawlState.js";
import { CrawlState } from "../domain/crawl/CrawlState.js";
import { DynamicRenderer } from "../domain/crawl/DynamicRenderer.js";
import { FetchService } from "../domain/crawl/FetchService.js";
import {
	PagePipeline,
	PagePipelineError,
	type PageProcessResult,
} from "../domain/crawl/PagePipeline.js";
import type { RobotsService } from "../domain/crawl/RobotsService.js";
import type { CrawlRenderer } from "../domain/crawl/rendering/contracts.js";
import type { HttpClient } from "../outbound/HttpClient.js";
import type { StorageRepos } from "../storage/db.js";
import { raceAbort } from "../utils/abort.js";
import { getErrorMessage, toError } from "../utils/helpers.js";
import type { AcquireWork } from "../utils/WorkPermitPool.js";
import type { EventStream } from "./EventStream.js";

export interface CrawlRuntimeDependencies {
	crawlId: string;
	options: CrawlOptions;
	logger: Logger;
	repos: StorageRepos;
	/** Re-reserves durable capacity for the pages this crawl may still store. */
	reserveStorage(pagesScanned: number): void;
	eventStream: EventStream;
	httpClient: HttpClient;
	robotsService: RobotsService;
	dynamicRenderer?: CrawlRenderer;
	acquirePdfWork?: AcquireWork;
	allowLocalhostSeed?: boolean;
	initialCounters?: CrawlCounters;
	initialStartedAtMs?: number;
	initialDomainStates?: DomainStateRecord[];
	resume: boolean;
	/** The last durable event sequence; this runtime numbers its events after it. */
	eventSequence: number;
	onInactive?: () => void;
	onSettled: () => void;
}

/**
 * - initializing: restoring state and starting the renderer; no page work yet
 * - crawling: dispatching and settling page work
 * - settling: the run failed; late page results are discarded
 * - inactive: the final status is persisted; no further work or status writes
 */
type RuntimePhase = "initializing" | "crawling" | "settling" | "inactive";

/**
 * How a stop request ends the run. A force stop discards pending work; an interrupt
 * (process shutdown) keeps it resumable. Once interrupted, a force stop is ignored,
 * and an interrupt after a force stop still ends the run as stopped.
 */
type StopIntent = "pause" | "force-stop" | "interrupt";

class RuntimeStopSignalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeStopSignalError";
	}
}

export class CrawlRuntime {
	private readonly state: CrawlState;
	private readonly queue: CrawlQueue;
	private readonly dynamicRenderer: CrawlRenderer;
	private readonly pipeline: PagePipeline;
	private readonly activeTasks = new Map<string, Promise<void>>();
	private readonly activeControllers = new Map<string, AbortController>();
	private readonly lifecycleController = new AbortController();
	private runPromise: Promise<void> | null = null;
	private phase: RuntimePhase = "initializing";
	private stopIntent: StopIntent | null = null;
	private activeTaskFailure: unknown = null;
	private sequence: number;

	constructor(private readonly deps: CrawlRuntimeDependencies) {
		this.sequence = deps.eventSequence;
		this.state = new CrawlState(deps.options, {
			...(deps.initialCounters === undefined ? {} : { initialCounters: deps.initialCounters }),
			...(deps.initialDomainStates === undefined
				? {}
				: { initialDomainStates: deps.initialDomainStates }),
			...(deps.initialStartedAtMs === undefined ? {} : { startedAtMs: deps.initialStartedAtMs }),
			onDomainStateChanged: (record) => deps.repos.crawlDomainState.upsert(deps.crawlId, record),
		});
		const localSeedUrl = deps.allowLocalhostSeed ? deps.options.target : undefined;
		this.dynamicRenderer =
			deps.dynamicRenderer ??
			new DynamicRenderer({
				enabled: deps.options.dynamic,
				logger: deps.logger,
				httpClient: deps.httpClient,
				...(localSeedUrl === undefined ? {} : { localSeedUrl }),
			});
		const fetchService = new FetchService({
			httpClient: deps.httpClient,
			dynamicRenderer: this.dynamicRenderer,
			logger: deps.logger,
			...(localSeedUrl === undefined ? {} : { localSeedUrl }),
			...(deps.acquirePdfWork === undefined ? {} : { acquirePdfWork: deps.acquirePdfWork }),
		});
		this.queue = new CrawlQueue(deps.options, this.state, {
			enqueueMany: (items) => deps.repos.crawlQueue.enqueueMany(deps.crawlId, items),
			reschedule: (item) => deps.repos.crawlQueue.reschedule(deps.crawlId, item),
			clear: () => deps.repos.crawlQueue.clear(deps.crawlId),
		});
		const eventSink = {
			log: (message: string, level: CrawlLogLevel = "info") =>
				this.publish("crawl.log", {
					message,
					level,
				}),
		};
		this.pipeline = new PagePipeline({
			options: deps.options,
			state: this.state,
			queue: this.queue,
			fetchService,
			robotsService: deps.robotsService,
			eventSink,
			logger: deps.logger,
			...(localSeedUrl === undefined ? {} : { localSeedUrl }),
		});
	}

	/** The sequence of the last event this runtime published (or restored from storage). */
	get eventSequence(): number {
		return this.sequence;
	}

	/** Allocates the next event sequence, persists it, then delivers the event. */
	private publish<TType extends CrawlEventType>(type: TType, payload: CrawlEventMap[TType]) {
		const sequence = this.sequence + 1;
		this.deps.repos.crawlRuns.advanceEventSequence(this.deps.crawlId, sequence);
		this.sequence = sequence;
		return this.deps.eventStream.publish(this.deps.crawlId, sequence, type, payload);
	}

	private get stopSignalReason(): Error {
		return new RuntimeStopSignalError(this.state.stopReason ?? "Runtime stop requested");
	}

	private throwIfForceStopped(): void {
		if (this.stopIntent === "force-stop") {
			throw this.stopSignalReason;
		}
	}

	private awaitStartupStep<T>(step: Promise<T>): Promise<T> {
		return raceAbort(step, this.lifecycleController.signal, () => this.stopSignalReason);
	}

	private persistActiveStatus(status: Exclude<ActiveCrawlStatus, "pending">): void {
		const stopReason = status === "pausing" || status === "stopping" ? this.state.stopReason : null;
		this.deps.repos.crawlRuns.transition(this.deps.crawlId, status, {
			stopReason,
			eventSequence: this.sequence,
		});
	}

	/** Persists a settled status carrying the sequence of the event about to announce it. */
	private persistSettledStatus(
		status: "paused" | "completed" | "stopped" | "failed",
		stopReason: string | null,
	) {
		return this.deps.repos.crawlRuns.transition(this.deps.crawlId, status, {
			stopReason,
			eventSequence: this.sequence + 1,
		});
	}

	private emitProgress() {
		this.publish(
			"crawl.progress",
			this.state.buildProgress({
				activeRequests: this.queue.activeCount,
				queueLength: this.queue.pendingCount,
			}),
		);
	}

	private async seedInitialQueue(): Promise<void> {
		if (this.deps.resume) {
			const terminalUrls = this.deps.repos.crawlItems.listTerminalUrls(this.deps.crawlId);
			this.state.restoreTerminals(terminalUrls);
		}

		const pending = this.deps.repos.crawlQueue.listPending(this.deps.crawlId);
		if (pending.length === 0 && !this.deps.resume) {
			throw new Error("New crawl is missing its durably committed initial queue item");
		}
		this.queue.restore(pending);
	}

	start(): Promise<void> {
		this.runPromise ??= this.run();
		return this.runPromise;
	}

	waitUntilSettled(): Promise<void> {
		return this.runPromise ?? Promise.resolve();
	}

	async requestPause(reason = "Pause requested"): Promise<void> {
		if (this.stopIntent === "force-stop" || this.stopIntent === "interrupt") {
			return this.waitUntilSettled();
		}

		this.stopIntent = "pause";
		this.state.requestStop(reason);
		this.queue.deferPendingToDomainDelays();
		if (this.phase === "crawling") {
			this.persistActiveStatus("pausing");
		}
		await this.waitUntilSettled();
	}

	async requestForceStop(reason = "Force stop requested"): Promise<void> {
		if (this.stopIntent === "interrupt") {
			return this.waitUntilSettled();
		}

		this.stopIntent = "force-stop";
		this.state.requestStop(reason, { overrideReason: true });
		this.lifecycleController.abort(this.stopSignalReason);
		this.queue.discard();
		for (const controller of this.activeControllers.values()) {
			controller.abort(new Error(reason));
		}
		if (this.phase === "crawling") {
			this.persistActiveStatus("stopping");
		}
		await this.dynamicRenderer.close();
		await this.waitUntilSettled();
	}

	async interrupt(reason = "Runtime interrupted"): Promise<void> {
		const forceStopping = this.stopIntent === "force-stop";
		if (!forceStopping) this.stopIntent = "interrupt";
		this.state.requestStop(reason, { overrideReason: !forceStopping });
		this.lifecycleController.abort(this.stopSignalReason);
		this.queue.deferPendingToDomainDelays();
		for (const controller of this.activeControllers.values()) {
			controller.abort(new Error(reason));
		}
		await this.dynamicRenderer.close();
	}

	private async launchWork(item: Parameters<PagePipeline["process"]>[0]): Promise<void> {
		const controller = new AbortController();
		this.activeControllers.set(item.url, controller);
		let finalized = false;
		const task = this.executeItem(item, controller.signal)
			.then((processResult) => {
				if (this.phase !== "crawling") return;
				this.finalizeItem(item, processResult);
				finalized = true;
			})
			.catch((error) => {
				this.activeTaskFailure ??= error;
			})
			.finally(() => {
				this.activeTasks.delete(item.url);
				this.activeControllers.delete(item.url);
				if (finalized && this.phase === "crawling") {
					this.emitProgress();
				}
			});

		this.activeTasks.set(item.url, task);
	}

	private async executeItem(
		item: QueueItem,
		externalSignal?: AbortSignal,
	): Promise<PageProcessResult> {
		try {
			return await this.pipeline.process(item, externalSignal);
		} catch (error) {
			if (externalSignal?.aborted) {
				return { aborted: true };
			}

			this.deps.logger.error(`[Runtime] Failed to process ${item.url}: ${getErrorMessage(error)}`);
			this.publish("crawl.log", { message: `[Crawler] Failure: ${item.url}`, level: "error" });
			return {
				terminalOutcome: "failure",
				terminalEffects: {
					chargeDomainBudget: true,
					...(error instanceof PagePipelineError && error.chargedDomain
						? { chargedDomain: error.chargedDomain }
						: {}),
				},
			};
		}
	}

	private finalizeItem(item: QueueItem, processResult: PageProcessResult): void {
		if (processResult.aborted || processResult.rescheduled) {
			this.state.releaseAttempt(item.url);
			this.queue.markDone(item);
			return;
		}

		const terminalEffects = processResult.terminalEffects;
		if (this.state.hasVisited(item.url)) {
			throw new Error(`Cannot complete already-terminal URL: ${item.url}`);
		}
		const domainBudgetCharged = terminalEffects.chargeDomainBudget;
		const pendingPageEvent = processResult.page ? 1 : 0;
		const commitBase = {
			crawlId: this.deps.crawlId,
			url: item.url,
			domainBudgetCharged,
			...(domainBudgetCharged
				? { chargedDomain: terminalEffects.chargedDomain ?? item.domain }
				: {}),
			eventSequence: this.sequence + pendingPageEvent,
		};
		const itemCommit = (() => {
			if (processResult.page) {
				return this.deps.repos.crawlItems.commitCompletedItem({
					...commitBase,
					outcome: "success",
					page: processResult.page.pageData,
				});
			}

			return this.deps.repos.crawlItems.commitCompletedItem({
				...commitBase,
				outcome: processResult.terminalOutcome,
			});
		})();
		this.deps.reserveStorage(itemCommit.counters.pagesScanned);

		this.state.applyCommittedTerminal(item.url, processResult.terminalOutcome, itemCommit);

		if (processResult.page) {
			if (itemCommit.type !== "page-persisted") {
				throw new Error("Page completion did not return its persisted identity");
			}
			this.publish("crawl.page", {
				...processResult.page.eventPayload,
				id: itemCommit.pageId,
				pageCount: itemCommit.pageCount,
			});
		}

		this.queue.markDone(item);
	}

	private async initializeRuntime(): Promise<void> {
		this.persistActiveStatus("starting");
		if (this.stopIntent !== "force-stop") {
			await this.seedInitialQueue();
		}
		this.throwIfForceStopped();
		if (this.queue.pendingCount > 0) {
			const initResult = await this.awaitStartupStep(
				this.dynamicRenderer.initialize(this.lifecycleController.signal),
			);
			this.throwIfForceStopped();
			if (!initResult.dynamicEnabled && initResult.fallbackLog) {
				this.publish("crawl.log", { message: initResult.fallbackLog, level: "warn" });
			}
		}
		this.phase = "crawling";
		if (this.state.isStopRequested) {
			this.persistActiveStatus(this.stopIntent === "force-stop" ? "stopping" : "pausing");
		} else {
			this.persistActiveStatus("running");
		}
		this.publish("crawl.started", {
			target: this.deps.options.target,
			resume: this.deps.resume,
			// A renderer that never had work to start stays available; only a failed start disables it.
			dynamicRendering: this.dynamicRenderer.isEnabled(),
		});
		this.emitProgress();
	}

	private finishStopped(): void {
		this.queue.discard();
		const stopReason = this.state.stopReason ?? "Crawl stopped";
		const stopped = this.persistSettledStatus("stopped", stopReason);
		this.markInactive();
		this.publish("crawl.stopped", {
			stopReason,
			counters: stopped.counters,
		});
	}

	private markInactive(): void {
		if (this.phase === "inactive") return;
		this.phase = "inactive";
		this.deps.onInactive?.();
	}

	/** Settles a run that ended by request; false when nothing requested an early end. */
	private finalizeRequestedLifecycle(): boolean {
		if (this.phase === "inactive") return true;
		switch (this.stopIntent) {
			case "force-stop":
				this.finishStopped();
				return true;
			case "interrupt":
				this.queue.deferPendingToDomainDelays();
				this.deps.repos.crawlRuns.transition(this.deps.crawlId, "interrupted", {
					stopReason: this.state.stopReason ?? "Process shutdown",
					eventSequence: this.sequence,
				});
				this.markInactive();
				return true;
			case "pause":
				this.finishPaused();
				return true;
			case null:
				// The crawl state can stop itself (page budget, circuit breaker) without a request.
				if (!this.state.isStopRequested) return false;
				this.finishStopped();
				return true;
		}
	}

	private finishPaused(): void {
		this.queue.deferPendingToDomainDelays();
		this.publish("crawl.log", { message: this.state.stopReason ?? "Crawl paused", level: "info" });
		this.emitProgress();
		const paused = this.persistSettledStatus("paused", this.state.stopReason);
		this.markInactive();
		this.publish("crawl.paused", { stopReason: this.state.stopReason, counters: paused.counters });
	}

	private async run(): Promise<void> {
		try {
			await this.initializeRuntime();

			while (
				(!this.state.isStopRequested && this.queue.pendingCount > 0) ||
				this.queue.activeCount > 0
			) {
				while (
					!this.state.isStopRequested &&
					this.queue.activeCount < this.deps.options.maxConcurrentRequests
				) {
					const { item, waitMs } = this.queue.nextReady();
					if (!item) {
						if (waitMs > 0) {
							await Bun.sleep(Math.min(waitMs, CRAWL_QUEUE_CONSTANTS.DEFAULT_SLEEP_MS));
						}
						break;
					}

					await this.launchWork(item);
				}

				if (this.activeTasks.size === 0) {
					if (this.state.isStopRequested || this.queue.pendingCount === 0) {
						break;
					}
					await Bun.sleep(CRAWL_QUEUE_CONSTANTS.DEFAULT_SLEEP_MS);
					continue;
				}

				await Promise.race(this.activeTasks.values());
				if (this.activeTaskFailure) {
					throw this.activeTaskFailure;
				}
			}

			await Promise.allSettled(this.activeTasks.values());
			await this.dynamicRenderer.close();
			if (this.finalizeRequestedLifecycle()) return;

			this.queue.discard();

			const completed = this.persistSettledStatus("completed", null);
			this.markInactive();
			this.publish("crawl.completed", {
				counters: completed.counters,
			});
		} catch (error) {
			if (this.phase !== "inactive") this.phase = "settling";
			for (const controller of this.activeControllers.values()) {
				controller.abort(toError(error));
			}
			await Promise.allSettled(this.activeTasks.values());
			await this.dynamicRenderer.close();
			if (error instanceof RuntimeStopSignalError && this.finalizeRequestedLifecycle()) {
				return;
			}
			const message = getErrorMessage(error);
			const failed = this.persistSettledStatus("failed", message);
			this.queue.discard();
			this.markInactive();
			this.publish("crawl.failed", {
				error: message,
				counters: failed.counters,
			});
		} finally {
			const persisted = this.deps.repos.crawlRuns.getById(this.deps.crawlId);
			if (!persisted || !isActiveCrawlStatus(persisted.status)) {
				this.markInactive();
				this.deps.onSettled();
			}
		}
	}
}
