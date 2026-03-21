import type { Logger } from "../config/logging.js";
import { CRAWL_QUEUE_CONSTANTS } from "../constants.js";
import type { CrawlCounters, CrawlOptions } from "../contracts/crawl.js";
import type {
	CrawlEventMap,
	CrawlEventType,
	CrawlPagePayload,
} from "../contracts/events.js";
import { CrawlQueue, type QueueItem } from "../domain/crawl/CrawlQueue.js";
import { CrawlState } from "../domain/crawl/CrawlState.js";
import { DynamicRenderer } from "../domain/crawl/DynamicRenderer.js";
import { FetchService } from "../domain/crawl/FetchService.js";
import { PagePipeline } from "../domain/crawl/PagePipeline.js";
import { RobotsService } from "../domain/crawl/RobotsService.js";
import type { HttpClient, Resolver } from "../plugins/security.js";
import type { StorageRepos } from "../storage/db.js";
import { withTimeout } from "../utils/timeout.js";
import type { EventStream } from "./EventStream.js";

interface CrawlRuntimeDependencies {
	crawlId: string;
	options: CrawlOptions;
	logger: Logger;
	repos: StorageRepos;
	eventStream: EventStream;
	resolver: Resolver;
	httpClient: HttpClient;
	initialSequence?: number;
	initialCounters?: CrawlCounters;
	resume: boolean;
	onSettled: () => void;
}

interface EventSink {
	log(message: string): void;
	page(payload: CrawlPagePayload): void;
}

const sleep = (ms: number) => Bun.sleep(ms);

export class CrawlRuntime {
	private readonly state: CrawlState;
	private readonly queue: CrawlQueue;
	private readonly dynamicRenderer: DynamicRenderer;
	private readonly fetchService: FetchService;
	private readonly robotsService: RobotsService;
	private readonly pipeline: PagePipeline;
	private readonly activeTasks = new Map<string, Promise<void>>();
	private runPromise: Promise<void> | null = null;
	private interrupted = false;
	private interruptionPersisted = false;
	private started = false;

	constructor(private readonly deps: CrawlRuntimeDependencies) {
		this.state = new CrawlState(deps.options, deps.initialCounters, {
			onTerminal: (url, outcome) =>
				deps.repos.crawlTerminals.upsert(deps.crawlId, url, outcome),
		});
		this.dynamicRenderer = new DynamicRenderer(
			deps.options,
			deps.logger,
			deps.resolver,
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
			page: (payload) => this.publish("crawl.page", payload),
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

	private persistProgress(status?: "starting" | "running" | "stopping") {
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

		this.deps.repos.crawlRuns.updateProgress(
			this.deps.crawlId,
			this.state.counters,
			eventSequence,
		);
	}

	private emitProgress() {
		this.publish(
			"crawl.progress",
			this.state.buildProgress({
				activeRequests: this.queue.activeCount,
				queueLength: this.queue.pendingCount,
			}),
		);
		this.persistProgress();
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

	requestStop(reason = "Stop requested"): void {
		this.state.requestStop(reason);
		if (this.started) {
			this.persistProgress("stopping");
		}
	}

	async interrupt(reason = "Runtime interrupted"): Promise<void> {
		this.interrupted = true;
		this.state.requestStop(reason);
		this.queue.clearRetryTimers();
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
		const task = withTimeout(
			this.pipeline.process(item, controller.signal),
			CRAWL_QUEUE_CONSTANTS.ITEM_PROCESSING_TIMEOUT_MS,
			`Processing ${item.url}`,
		)
			.catch((error) => {
				controller.abort(error);
				this.deps.logger.error(
					`[Runtime] Failed to process ${item.url}: ${error instanceof Error ? error.message : String(error)}`,
				);
				this.state.recordTerminal(item.url, "failure");
				this.publish("crawl.log", {
					message: `[Crawler] Failure: ${item.url}`,
				});
			})
			.finally(() => {
				if (this.interrupted) {
					this.queue.markInterrupted(item);
				} else {
					this.queue.markDone(item);
				}

				this.activeTasks.delete(item.url);
				this.emitProgress();
			});

		this.activeTasks.set(item.url, task);
	}

	private async initializeRuntime(): Promise<void> {
		this.persistProgress("starting");
		await this.deps.resolver.assertPublicHostname(
			new URL(this.deps.options.target).hostname,
		);
		const initResult = await this.dynamicRenderer.initialize();
		if (!initResult.dynamicEnabled && initResult.fallbackLog) {
			this.publish("crawl.log", { message: initResult.fallbackLog });
		}

		if (this.deps.options.respectRobots) {
			const targetPolicy = await this.robotsService.evaluate(
				this.deps.options.target,
			);
			if (!targetPolicy.allowed) {
				throw new Error("Target URL is disallowed by robots.txt");
			}

			if (targetPolicy.crawlDelayMs !== undefined) {
				this.state.setDomainDelay(
					targetPolicy.domain,
					targetPolicy.crawlDelayMs,
				);
			}
		}

		await this.seedInitialQueue();
		this.persistProgress("running");
		this.started = true;
		this.publish("crawl.started", {
			target: this.deps.options.target,
			resume: this.deps.resume,
		});
		if (this.state.isStopRequested) {
			this.persistProgress("stopping");
		}
		this.emitProgress();
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
							await sleep(waitMs);
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
			}

			await Promise.allSettled(this.activeTasks.values());
			this.queue.clearRetryTimers();

			if (this.interrupted) {
				this.persistInterrupted(this.state.stopReason ?? "Process shutdown");
				return;
			}

			this.queue.clearPending();
			this.queue.clearPersisted();
			await this.dynamicRenderer.close();

			if (this.state.stopReason && this.state.isStopRequested) {
				this.publish("crawl.stopped", {
					stopReason: this.state.stopReason,
					counters: this.state.counters,
				});
				this.deps.repos.crawlRuns.markStopped(
					this.deps.crawlId,
					this.state.counters,
					this.state.stopReason,
					this.getCurrentSequence(),
				);
				return;
			}

			this.publish("crawl.completed", {
				counters: this.state.counters,
			});
			this.deps.repos.crawlRuns.markCompleted(
				this.deps.crawlId,
				this.state.counters,
				null,
				this.getCurrentSequence(),
			);
		} catch (error) {
			this.queue.clearRetryTimers();
			await this.dynamicRenderer.close();
			const message = error instanceof Error ? error.message : String(error);
			this.publish("crawl.failed", {
				error: message,
				counters: this.state.counters,
			});
			this.deps.repos.crawlRuns.markFailed(
				this.deps.crawlId,
				this.state.counters,
				message,
				this.getCurrentSequence(),
			);
		} finally {
			this.deps.onSettled();
		}
	}
}
