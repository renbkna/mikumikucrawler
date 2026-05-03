import type { Logger } from "../config/logging.js";
import { CRAWL_QUEUE_CONSTANTS } from "../constants.js";
import type {
	CrawlCounters,
	CrawlOptions,
} from "../../shared/contracts/index.js";
import type {
	CrawlEventMap,
	CrawlEventType,
} from "../../shared/contracts/index.js";
import { CrawlQueue, type QueueItem } from "../domain/crawl/CrawlQueue.js";
import { CrawlState } from "../domain/crawl/CrawlState.js";
import { DynamicRenderer } from "../domain/crawl/DynamicRenderer.js";
import { FetchService } from "../domain/crawl/FetchService.js";
import { PagePipeline } from "../domain/crawl/PagePipeline.js";
import type { DomainStateRecord } from "../domain/crawl/CrawlState.js";
import { RobotsService } from "../domain/crawl/RobotsService.js";
import type { HttpClient, Resolver } from "../plugins/security.js";
import type { StorageRepos } from "../storage/db.js";
import { CrawlItemExecutor } from "./CrawlItemExecutor.js";
import { CrawlItemFinalizer } from "./CrawlItemFinalizer.js";
import type { EventStream } from "./EventStream.js";

export interface CrawlRuntimeDependencies {
	crawlId: string;
	options: CrawlOptions;
	logger: Logger;
	repos: StorageRepos;
	eventStream: EventStream;
	resolver: Resolver;
	httpClient: HttpClient;
	initialSequence?: number;
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

const sleep = (ms: number) => Bun.sleep(ms);

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
	private readonly fetchService: FetchService;
	private readonly robotsService: RobotsService;
	private readonly pipeline: PagePipeline;
	private readonly executor: CrawlItemExecutor;
	private readonly finalizer: CrawlItemFinalizer;
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
	private lastDurableCounters: CrawlCounters;

	constructor(private readonly deps: CrawlRuntimeDependencies) {
		this.state = new CrawlState(
			deps.options,
			deps.initialCounters,
			{
				onTerminal: undefined,
				onDomainStateChanged: (record) =>
					deps.repos.crawlDomainState.upsert(deps.crawlId, record),
			},
			deps.initialStartedAtMs,
			deps.initialDomainStates,
		);
		this.lastDurableCounters = this.state.snapshotCounters();
		this.dynamicRenderer = new DynamicRenderer(
			deps.options,
			deps.logger,
			deps.httpClient,
		);
		this.fetchService = new FetchService(
			deps.repos.pages,
			deps.httpClient,
			this.dynamicRenderer,
			deps.logger,
		);
		this.robotsService = new RobotsService(deps.httpClient, deps.logger);
		const toPersistedQueueItem = (
			item: QueueItem,
		): QueueItem & { availableAt: number } => ({
			...item,
			availableAt: item.availableAt ?? 0,
		});
		this.queue = new CrawlQueue(deps.options, this.state, deps.logger, {
			enqueueMany: (items) =>
				deps.repos.crawlQueue.enqueueMany(
					deps.crawlId,
					items.map(toPersistedQueueItem),
				),
			reschedule: (item) =>
				deps.repos.crawlQueue.reschedule(
					deps.crawlId,
					toPersistedQueueItem(item),
				),
			remove: (url) => deps.repos.crawlQueue.remove(deps.crawlId, url),
			clear: () => deps.repos.crawlQueue.clear(deps.crawlId),
		});
		const eventSink: EventSink = {
			log: (message) =>
				this.publish("crawl.log", {
					message,
				}),
		};
		this.pipeline = new PagePipeline(
			deps.crawlId,
			deps.options,
			this.state,
			this.queue,
			deps.repos.pages,
			this.fetchService,
			this.robotsService,
			eventSink,
			deps.logger,
		);
		this.executor = new CrawlItemExecutor({
			pipeline: this.pipeline,
			state: this.state,
			logger: deps.logger,
			log: eventSink.log,
		});
		this.finalizer = new CrawlItemFinalizer({
			crawlId: deps.crawlId,
			state: this.state,
			queue: this.queue,
			repos: deps.repos,
			eventStream: deps.eventStream,
			getCurrentSequence: () => this.getCurrentSequence(),
		});

		if (deps.initialSequence) {
			deps.eventStream.initialize(deps.crawlId, deps.initialSequence);
		}
	}

	private publish<TType extends CrawlEventType>(
		type: TType,
		payload: CrawlEventMap[TType],
	) {
		return this.deps.eventStream.publish(this.deps.crawlId, type, payload);
	}

	private getCurrentSequence(): number {
		return this.deps.eventStream.getCurrentSequence(this.deps.crawlId);
	}

	private get stopSignalReason(): Error {
		return new RuntimeStopSignalError(
			this.state.stopReason ?? "Runtime stop requested",
		);
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

	private persistProgress(
		status?: "starting" | "running" | "pausing" | "stopping",
	) {
		const eventSequence = this.getCurrentSequence();
		if (status === "starting") {
			this.deps.repos.crawlRuns.markStarting(
				this.deps.crawlId,
				this.state.counters,
				eventSequence,
			);
			return;
		}

		if (status === "running") {
			this.deps.repos.crawlRuns.markRunning(
				this.deps.crawlId,
				this.state.counters,
				eventSequence,
			);
			return;
		}

		if (status === "stopping") {
			this.deps.repos.crawlRuns.markStopping(
				this.deps.crawlId,
				this.state.counters,
				this.state.stopReason,
				eventSequence,
			);
			return;
		}

		if (status === "pausing") {
			this.deps.repos.crawlRuns.markPausing(
				this.deps.crawlId,
				this.state.counters,
				this.state.stopReason,
				eventSequence,
			);
			return;
		}

		this.deps.repos.crawlRuns.updateProgress(
			this.deps.crawlId,
			this.state.counters,
			eventSequence,
		);
	}

	private emitProgress() {
		const counters = this.state.snapshotCounters();
		const eventSequence = this.getCurrentSequence() + 1;
		this.deps.repos.crawlRuns.updateProgress(
			this.deps.crawlId,
			counters,
			eventSequence,
		);
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
		this.queue.deferPendingByDelayKey((delayKey) =>
			this.state.nextAllowedAtForDomain(delayKey),
		);
	}

	private async seedInitialQueue(): Promise<void> {
		if (this.deps.resume) {
			const terminalUrls = this.deps.repos.crawlTerminals.listByCrawlId(
				this.deps.crawlId,
			);
			this.state.restoreTerminals(terminalUrls);
			const pending = this.deps.repos.crawlQueue.listPending(this.deps.crawlId);
			this.queue.restore(pending);
			return;
		}

		this.queue.enqueue({
			url: this.deps.options.target,
			depth: 0,
			retries: 0,
		});
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
		this.queue.clearRetryTimers();
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
		this.queue.clearRetryTimers();
		for (const controller of this.activeControllers.values()) {
			controller.abort(new Error(reason));
		}
		this.persistInterrupted(reason);
		await this.dynamicRenderer.close();
	}

	private persistInterrupted(reason: string): void {
		if (this.interruptionPersisted) {
			return;
		}

		this.deps.repos.crawlRuns.markInterrupted(
			this.deps.crawlId,
			this.state.counters,
			reason,
			this.getCurrentSequence(),
		);
		this.interruptionPersisted = true;
	}

	private async launchWork(
		item: Parameters<PagePipeline["process"]>[0],
	): Promise<void> {
		const controller = new AbortController();
		this.activeControllers.set(item.url, controller);
		let finalized = false;
		const task = this.executor
			.execute(item, controller.signal)
			.then((processResult) => {
				if (this.terminalizing) {
					return;
				}
				this.finalizer.finalize(item, processResult, {
					interrupted: this.interrupted,
				});
				this.lastDurableCounters = this.state.snapshotCounters();
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

	private async initializeRuntime(): Promise<void> {
		this.persistProgress("starting");
		await this.awaitStartupStep(
			this.deps.resolver.assertPublicHostname(
				new URL(this.deps.options.target).hostname,
			),
		);
		this.throwIfForceStopped();
		const initResult = await this.awaitStartupStep(
			this.dynamicRenderer.initialize(this.lifecycleController.signal),
		);
		this.throwIfForceStopped();
		if (!initResult.dynamicEnabled && initResult.fallbackLog) {
			this.publish("crawl.log", { message: initResult.fallbackLog });
		}

		if (this.deps.options.respectRobots) {
			const targetPolicy = await this.awaitStartupStep(
				this.robotsService.evaluate(
					this.deps.options.target,
					this.lifecycleController.signal,
				),
			);
			this.throwIfForceStopped();
			if (!targetPolicy.allowed) {
				throw new Error("Target URL is disallowed by robots.txt");
			}

			if (targetPolicy.crawlDelayMs !== undefined) {
				this.state.setDomainDelay(
					targetPolicy.delayKey,
					targetPolicy.crawlDelayMs,
				);
			}
		}

		if (!this.forceStopRequested) {
			await this.seedInitialQueue();
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
		this.deps.repos.crawlRuns.markStopped(
			this.deps.crawlId,
			this.state.counters,
			stopReason,
			this.getCurrentSequence() + 1,
		);
		this.markInactive();
		this.publish("crawl.stopped", {
			stopReason,
			counters: this.state.counters,
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
							await sleep(
								Math.min(waitMs, CRAWL_QUEUE_CONSTANTS.DEFAULT_SLEEP_MS),
							);
						}
						break;
					}

					await this.launchWork(item);
				}

				if (this.activeTasks.size === 0) {
					if (this.state.isStopRequested || this.queue.pendingCount === 0) {
						break;
					}
					await sleep(CRAWL_QUEUE_CONSTANTS.DEFAULT_SLEEP_MS);
					continue;
				}

				await Promise.race(this.activeTasks.values());
				if (this.activeTaskFailure) {
					throw this.activeTaskFailure;
				}
			}

			await Promise.allSettled(this.activeTasks.values());
			this.queue.clearRetryTimers();

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
				this.deps.repos.crawlRuns.markPaused(
					this.deps.crawlId,
					this.state.counters,
					this.state.stopReason,
					this.getCurrentSequence() + 1,
				);
				this.markInactive();
				this.publish("crawl.paused", {
					stopReason: this.state.stopReason,
					counters: this.state.counters,
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

			this.deps.repos.crawlRuns.markCompleted(
				this.deps.crawlId,
				this.state.counters,
				null,
				this.getCurrentSequence() + 1,
			);
			this.markInactive();
			this.publish("crawl.completed", {
				counters: this.state.counters,
			});
		} catch (error) {
			this.terminalizing = true;
			for (const controller of this.activeControllers.values()) {
				controller.abort(
					error instanceof Error ? error : new Error("Runtime failed"),
				);
			}
			await Promise.allSettled([...this.activeTasks.values()]);
			this.queue.clearRetryTimers();
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
			this.deps.repos.crawlRuns.markFailed(
				this.deps.crawlId,
				this.lastDurableCounters,
				message,
				this.getCurrentSequence() + 1,
			);
			this.markInactive();
			this.publish("crawl.failed", {
				error: message,
				counters: this.lastDurableCounters,
			});
		} finally {
			this.deps.onSettled();
		}
	}
}
