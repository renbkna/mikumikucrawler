import type {
	ActiveCrawlStatus,
	CrawlCounters,
	CrawlEventMap,
	CrawlEventType,
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
import type { HttpClient } from "../outbound/HttpClient.js";
import type { DurableStorageBudget } from "../storage/DurableStorageBudget.js";
import type { StorageRepos } from "../storage/db.js";
import type { AcquireWork } from "../utils/WorkPermitPool.js";
import type { EventStream } from "./EventStream.js";

export interface CrawlRuntimeDependencies {
	crawlId: string;
	options: CrawlOptions;
	logger: Logger;
	repos: StorageRepos;
	storageBudget: DurableStorageBudget;
	eventStream: EventStream;
	httpClient: HttpClient;
	robotsService: RobotsService;
	acquirePdfWork?: AcquireWork;
	allowLocalhostSeed?: boolean;
	initialCounters?: CrawlCounters;
	initialStartedAtMs?: number;
	initialDomainStates?: DomainStateRecord[];
	resume: boolean;
	onInactive?: () => void;
	onSettled: () => void;
}

interface EventSink {
	log(message: string): void;
}

class RuntimeStopSignalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeStopSignalError";
	}
}

export class CrawlRuntime {
	private readonly state: CrawlState;
	private readonly queue: CrawlQueue;
	private readonly dynamicRenderer: DynamicRenderer;
	private readonly pipeline: PagePipeline;
	private readonly activeTasks = new Map<string, Promise<void>>();
	private readonly activeControllers = new Map<string, AbortController>();
	private readonly lifecycleController = new AbortController();
	private runPromise: Promise<void> | null = null;
	private interrupted = false;
	private interruptionPersisted = false;
	private pauseRequested = false;
	private forceStopRequested = false;
	private started = false;
	private inactiveNotified = false;
	private terminalizing = false;
	private activeTaskFailure: unknown = null;

	constructor(private readonly deps: CrawlRuntimeDependencies) {
		this.state = new CrawlState(
			deps.options,
			deps.initialCounters,
			{
				onDomainStateChanged: (record) => deps.repos.crawlDomainState.upsert(deps.crawlId, record),
			},
			deps.initialStartedAtMs,
			deps.initialDomainStates,
		);
		this.dynamicRenderer = new DynamicRenderer(deps.options, deps.logger, deps.httpClient);
		const fetchService = new FetchService(
			deps.httpClient,
			this.dynamicRenderer,
			deps.logger,
			deps.allowLocalhostSeed ? deps.options.target : undefined,
			deps.acquirePdfWork,
		);
		const toPersistedQueueItem = (item: QueueItem): QueueItem & { availableAt: number } => ({
			...item,
			availableAt: item.availableAt ?? 0,
		});
		this.queue = new CrawlQueue(deps.options, this.state, {
			enqueueMany: (items) =>
				deps.repos.crawlQueue.enqueueMany(deps.crawlId, items.map(toPersistedQueueItem)),
			reschedule: (item) =>
				deps.repos.crawlQueue.reschedule(deps.crawlId, toPersistedQueueItem(item)),
			clear: () => deps.repos.crawlQueue.clear(deps.crawlId),
		});
		const eventSink: EventSink = {
			log: (message) =>
				this.publish("crawl.log", {
					message,
				}),
		};
		this.pipeline = new PagePipeline(
			deps.options,
			this.state,
			this.queue,
			fetchService,
			deps.robotsService,
			eventSink,
			deps.logger,
			deps.allowLocalhostSeed ? deps.options.target : undefined,
		);
	}

	private publish<TType extends CrawlEventType>(type: TType, payload: CrawlEventMap[TType]) {
		this.deps.repos.crawlRuns.advanceEventSequence(
			this.deps.crawlId,
			this.getCurrentSequence() + 1,
		);
		return this.deps.eventStream.publish(this.deps.crawlId, type, payload);
	}

	private getCurrentSequence(): number {
		return this.deps.eventStream.getCurrentSequence(this.deps.crawlId);
	}

	private get stopSignalReason(): Error {
		return new RuntimeStopSignalError(this.state.stopReason ?? "Runtime stop requested");
	}

	private throwIfForceStopped(): void {
		if (this.forceStopRequested) {
			throw this.stopSignalReason;
		}
	}

	private async awaitStartupStep<T>(step: Promise<T>): Promise<T> {
		const signal = this.lifecycleController.signal;
		if (signal.aborted) {
			throw this.stopSignalReason;
		}

		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(this.stopSignalReason);
			};

			signal.addEventListener("abort", onAbort, { once: true });
			step.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	private persistProgress(status?: Exclude<ActiveCrawlStatus, "pending">) {
		const eventSequence = this.getCurrentSequence();
		if (status === "starting") {
			this.deps.repos.crawlRuns.markStarting(this.deps.crawlId, eventSequence);
			return;
		}

		if (status === "running") {
			this.deps.repos.crawlRuns.markRunning(this.deps.crawlId, eventSequence);
			return;
		}

		if (status === "stopping") {
			this.deps.repos.crawlRuns.markStopping(
				this.deps.crawlId,
				this.state.stopReason,
				eventSequence,
			);
			return;
		}

		if (status === "pausing") {
			this.deps.repos.crawlRuns.markPausing(
				this.deps.crawlId,
				this.state.stopReason,
				eventSequence,
			);
			return;
		}

		this.deps.repos.crawlRuns.updateProgress(this.deps.crawlId, eventSequence);
	}

	private emitProgress() {
		const counters = this.state.snapshotCounters();
		this.publish(
			"crawl.progress",
			this.state.buildProgress(
				{
					activeRequests: this.queue.activeCount,
					queueLength: this.queue.pendingCount,
				},
				counters,
			),
		);
	}

	private deferPendingToDelayWatermarks(): void {
		this.queue.deferPendingByDelayKey((delayKey) => this.state.nextAllowedAtForDomain(delayKey));
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
		if (this.forceStopRequested || this.interrupted) {
			return this.waitUntilSettled();
		}

		this.pauseRequested = true;
		this.state.requestStop(reason);
		this.deferPendingToDelayWatermarks();
		if (this.started) {
			this.persistProgress("pausing");
		}
		await this.waitUntilSettled();
	}

	async requestForceStop(reason = "Force stop requested"): Promise<void> {
		if (this.interrupted) {
			return this.waitUntilSettled();
		}

		this.forceStopRequested = true;
		this.pauseRequested = false;
		this.state.requestStop(reason, { overrideReason: true });
		this.lifecycleController.abort(this.stopSignalReason);
		this.queue.clearPending();
		this.queue.clearPersisted();
		for (const controller of this.activeControllers.values()) {
			controller.abort(new Error(reason));
		}
		if (this.started) {
			this.persistProgress("stopping");
		}
		await this.dynamicRenderer.close();
		await this.waitUntilSettled();
	}

	async interrupt(reason = "Runtime interrupted"): Promise<void> {
		this.interrupted = true;
		this.state.requestStop(reason);
		this.lifecycleController.abort(this.stopSignalReason);
		this.deferPendingToDelayWatermarks();
		for (const controller of this.activeControllers.values()) {
			controller.abort(new Error(reason));
		}
		await this.dynamicRenderer.close();
	}

	private persistInterrupted(reason: string): void {
		if (this.interruptionPersisted) {
			return;
		}

		this.deps.repos.crawlRuns.markInterrupted(this.deps.crawlId, reason, this.getCurrentSequence());
		this.interruptionPersisted = true;
	}

	private async launchWork(item: Parameters<PagePipeline["process"]>[0]): Promise<void> {
		const controller = new AbortController();
		this.activeControllers.set(item.url, controller);
		let finalized = false;
		const task = this.executeItem(item, controller.signal)
			.then((processResult) => {
				if (this.terminalizing) {
					return;
				}
				this.finalizeItem(item, processResult);
				finalized = true;
			})
			.catch((error) => {
				this.activeTaskFailure ??= error;
			})
			.finally(() => {
				this.activeTasks.delete(item.url);
				this.activeControllers.delete(item.url);
				if (finalized && !this.terminalizing) {
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

			this.deps.logger.error(
				`[Runtime] Failed to process ${item.url}: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.publish("crawl.log", { message: `[Crawler] Failure: ${item.url}` });
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
		if (processResult.aborted) {
			this.state.releaseRedirectReservation(item.url);
			this.queue.markDone(item);
			return;
		}

		if (processResult.rescheduled) {
			this.state.releaseRedirectReservation(item.url);
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
			eventSequence: this.getCurrentSequence() + pendingPageEvent,
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
		const reservation = this.deps.storageBudget.reserve(this.deps.crawlId, {
			maxPages: this.deps.options.maxPages,
			pagesScanned: itemCommit.counters.pagesScanned,
		});
		for (const reclaimedCrawlId of reservation.reclaimedCrawlIds) {
			this.deps.eventStream.delete(reclaimedCrawlId);
		}

		this.state.recordTerminal(item.url, processResult.terminalOutcome, itemCommit.effects);
		if (!Bun.deepEquals(this.state.snapshotCounters(), itemCommit.counters, true)) {
			throw new Error("Runtime counters diverged from the committed crawl aggregate");
		}
		if (domainBudgetCharged) {
			if (itemCommit.chargedDomain === null) {
				throw new Error("Charged item completion omitted its durable domain identity");
			}
			this.state.settleDomainAdmission(item.url, item.domain, itemCommit.chargedDomain);
			this.state.recordDomainPage(itemCommit.chargedDomain);
		} else {
			this.state.releaseRedirectReservation(item.url);
			this.state.releaseDomainAdmission(item.domain);
		}

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
		this.persistProgress("starting");
		if (!this.forceStopRequested) {
			await this.seedInitialQueue();
		}
		this.throwIfForceStopped();
		if (this.queue.pendingCount > 0) {
			const initResult = await this.awaitStartupStep(
				this.dynamicRenderer.initialize(this.lifecycleController.signal),
			);
			this.throwIfForceStopped();
			if (!initResult.dynamicEnabled && initResult.fallbackLog) {
				this.publish("crawl.log", { message: initResult.fallbackLog });
			}
		}
		this.started = true;
		if (this.state.isStopRequested) {
			this.persistProgress(this.forceStopRequested ? "stopping" : "pausing");
		} else {
			this.persistProgress("running");
		}
		this.publish("crawl.started", {
			target: this.deps.options.target,
			resume: this.deps.resume,
		});
		this.emitProgress();
	}

	private finishStopped(): void {
		const stopReason = this.state.stopReason ?? "Crawl stopped";
		const stopped = this.deps.repos.crawlRuns.markStopped(
			this.deps.crawlId,
			stopReason,
			this.getCurrentSequence() + 1,
		);
		if (!stopped) {
			throw new Error(`Stopped crawl disappeared during terminal transition: ${this.deps.crawlId}`);
		}
		this.markInactive();
		this.publish("crawl.stopped", {
			stopReason,
			counters: stopped.counters,
		});
	}

	private markInactive(): void {
		if (this.inactiveNotified) {
			return;
		}

		this.inactiveNotified = true;
		this.deps.onInactive?.();
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

			if (this.interrupted) {
				this.deferPendingToDelayWatermarks();
				this.persistInterrupted(this.state.stopReason ?? "Process shutdown");
				this.markInactive();
				return;
			}

			if (this.pauseRequested && !this.forceStopRequested) {
				await this.dynamicRenderer.close();
				this.deferPendingToDelayWatermarks();
				this.publish("crawl.log", {
					message: this.state.stopReason ?? "Crawl paused",
				});
				this.emitProgress();
				const paused = this.deps.repos.crawlRuns.markPaused(
					this.deps.crawlId,
					this.state.stopReason,
					this.getCurrentSequence() + 1,
				);
				if (!paused) {
					throw new Error(`Paused crawl disappeared during transition: ${this.deps.crawlId}`);
				}
				this.markInactive();
				this.publish("crawl.paused", {
					stopReason: this.state.stopReason,
					counters: paused.counters,
				});
				return;
			}

			this.queue.clearPending();
			this.queue.clearPersisted();
			await this.dynamicRenderer.close();

			if (this.state.stopReason && this.state.isStopRequested) {
				this.finishStopped();
				return;
			}

			const completed = this.deps.repos.crawlRuns.markCompleted(
				this.deps.crawlId,
				null,
				this.getCurrentSequence() + 1,
			);
			if (!completed) {
				throw new Error(
					`Completed crawl disappeared during terminal transition: ${this.deps.crawlId}`,
				);
			}
			this.markInactive();
			this.publish("crawl.completed", {
				counters: completed.counters,
			});
		} catch (error) {
			this.terminalizing = true;
			for (const controller of this.activeControllers.values()) {
				controller.abort(error instanceof Error ? error : new Error("Runtime failed"));
			}
			await Promise.allSettled(this.activeTasks.values());
			await this.dynamicRenderer.close();
			if (
				this.forceStopRequested &&
				this.state.isStopRequested &&
				error instanceof RuntimeStopSignalError
			) {
				this.finishStopped();
				return;
			}
			if (
				this.interrupted &&
				this.state.isStopRequested &&
				error instanceof RuntimeStopSignalError
			) {
				this.deferPendingToDelayWatermarks();
				this.persistInterrupted(this.state.stopReason ?? "Process shutdown");
				this.markInactive();
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			const failed = this.deps.repos.crawlRuns.markFailed(
				this.deps.crawlId,
				message,
				this.getCurrentSequence() + 1,
			);
			if (!failed) {
				throw new Error(
					`Failed crawl disappeared during terminal transition: ${this.deps.crawlId}`,
					{ cause: error },
				);
			}
			this.queue.clearPending();
			this.queue.clearPersisted();
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
