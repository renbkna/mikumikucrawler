import type { Database } from "bun:sqlite";
import type { Logger } from "../../config/logging.js";
import { CRAWL_QUEUE_CONSTANTS } from "../../constants.js";
import type {
	CrawlerSocket,
	QueueItem,
	SanitizedCrawlOptions,
} from "../../types.js";
import { getErrorMessage } from "../../utils/helpers.js";
import {
	removeQueueItem,
	saveQueueItemBatch,
} from "../../utils/sessionPersistence.js";
import type { CrawlState } from "./crawlState.js";

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

interface CrawlQueueOptions {
	options: SanitizedCrawlOptions;
	state: CrawlState;
	logger: Logger;
	socket: CrawlerSocket;
	processItem: (item: QueueItem) => Promise<void>;
	onIdle?: () => Promise<void>;
	/** Optional session ID for persisting queue state to DB for resume support */
	sessionId?: string;
	/** Database instance required when sessionId is provided */
	db?: Database;
}

/** Manages the crawl queue with concurrency control and domain-specific delays. */
export class CrawlQueue {
	private readonly options: SanitizedCrawlOptions;
	private readonly state: CrawlState;
	private readonly logger: Logger;
	private readonly socket: CrawlerSocket;
	public processItem: (item: QueueItem) => Promise<void>;
	private readonly onIdle: () => Promise<void>;
	private readonly queue: QueueItem[];
	private queueHead = 0;
	private readonly activeItems: Set<string>;
	private readonly queuedUrls: Set<string>;
	private readonly retryTimers: Set<ReturnType<typeof setTimeout>>;
	private lastDomainCleanup = 0;
	private loopPromise: Promise<void> | null;
	/** Optional session ID used to persist queue items to DB for resume support */
	private readonly sessionId: string | undefined;
	/** DB reference for queue persistence (only set when sessionId is provided) */
	private readonly db: Database | undefined;
	/** Buffer of items awaiting batch-persistence to avoid per-item DB writes */
	private readonly persistBuffer: QueueItem[] = [];
	private static readonly PERSIST_BATCH_SIZE = 50;

	constructor({
		options,
		state,
		logger,
		socket,
		processItem,
		onIdle = async () => {},
		sessionId,
		db,
	}: CrawlQueueOptions) {
		this.options = options;
		this.state = state;
		this.logger = logger;
		this.socket = socket;
		this.processItem = processItem;
		this.onIdle = onIdle;
		this.sessionId = sessionId;
		this.db = db;

		this.queue = [];
		this.activeItems = new Set();
		this.queuedUrls = new Set();
		this.retryTimers = new Set();
		this.loopPromise = null;
	}

	get activeCount(): number {
		return this.activeItems.size;
	}

	enqueue(item: Omit<QueueItem, "domain"> & { url: string }): void {
		if (
			this.state.hasVisited(item.url) ||
			this.activeItems.has(item.url) ||
			this.queuedUrls.has(item.url)
		) {
			return;
		}

		const domain = new URL(item.url).hostname;

		const queueItem: QueueItem = { ...item, domain };
		this.queuedUrls.add(item.url);
		this.queue.push(queueItem);

		if (this.sessionId && this.db) {
			this.persistBuffer.push(queueItem);
			if (this.persistBuffer.length >= CrawlQueue.PERSIST_BATCH_SIZE) {
				saveQueueItemBatch(
					this.db,
					this.sessionId,
					this.persistBuffer.splice(0),
				);
			}
		}
	}

	scheduleRetry(item: QueueItem, delay: number): void {
		const timer = setTimeout(() => {
			this.retryTimers.delete(timer);
			if (!this.state.isActive) return;
			this.queuedUrls.delete(item.url);
			this.enqueue(item);
		}, delay);

		this.retryTimers.add(timer);
	}

	clearRetries(): void {
		for (const timer of this.retryTimers) {
			clearTimeout(timer);
		}
		this.retryTimers.clear();
	}

	flushPersistBuffer(): void {
		if (this.sessionId && this.db && this.persistBuffer.length > 0) {
			saveQueueItemBatch(this.db, this.sessionId, this.persistBuffer.splice(0));
		}
	}

	start(): Promise<void> {
		this.loopPromise ??= this.loop();
		return this.loopPromise;
	}

	private async loop(): Promise<void> {
		const domainProcessing = new Map<string, number>();
		const processingPromises = new Set<Promise<void>>();

		let lastProgressTime = Date.now();
		let lastScannedCount = 0;
		let lastProgressLog = 0;
		let stuckWarningCount = 0;
		const progressLogInterval =
			CRAWL_QUEUE_CONSTANTS.STUCK_DETECTION_INTERVAL_MS;
		const stuckThreshold = CRAWL_QUEUE_CONSTANTS.STUCK_WARNING_THRESHOLD_MS;
		const stuckForceClear =
			CRAWL_QUEUE_CONSTANTS.STUCK_FORCE_CLEAR_THRESHOLD_MS;
		const itemTimeout = CRAWL_QUEUE_CONSTANTS.ITEM_PROCESSING_TIMEOUT_MS;

		while (
			(this.queueHead < this.queue.length || this.activeCount > 0) &&
			(this.state.isActive || this.activeCount > 0)
		) {
			if (!this.state.isActive && this.queueHead < this.queue.length) {
				this.queue.length = 0;
				this.queueHead = 0;
				this.queuedUrls.clear();
			}

			let deferredDelay: number | null = null;

			const now = Date.now();
			if (now - this.lastDomainCleanup > 5000) {
				this.lastDomainCleanup = now;
				for (const [domain, nextAllowed] of domainProcessing) {
					if (
						now >
						nextAllowed + CRAWL_QUEUE_CONSTANTS.DOMAIN_ENTRY_EXPIRY_MS
					) {
						domainProcessing.delete(domain);
					}
				}
			}

			if (this.queueHead > CRAWL_QUEUE_CONSTANTS.QUEUE_COMPACTION_THRESHOLD) {
				this.queue.splice(0, this.queueHead);
				this.queueHead = 0;
			}

			const itemsAvailableNow = this.queue.length - this.queueHead;
			let deferredThisPass = 0;

			while (
				this.activeCount < this.options.maxConcurrentRequests &&
				this.queueHead < this.queue.length &&
				this.state.isActive
			) {
				const item = this.queue[this.queueHead++];
				if (!item) break;
				this.queuedUrls.delete(item.url);

				try {
					const domain = item.domain;

					const nextAllowed = domainProcessing.get(domain) || 0;
					const domainDelay = this.state.getDomainDelay(domain);

					if (now < nextAllowed) {
						const waitTime = nextAllowed - now;
						deferredDelay =
							deferredDelay === null
								? waitTime
								: Math.min(deferredDelay, waitTime);

						this.queue.push(item);
						this.queuedUrls.add(item.url);

						deferredThisPass++;
						if (
							deferredThisPass >= itemsAvailableNow ||
							this.queue.length === 1
						)
							break;
						continue;
					}

					deferredThisPass = 0;
					domainProcessing.set(domain, now + domainDelay);

					this.activeItems.add(item.url);

					const task = (() => {
						const timeoutPromise = new Promise<void>((_, reject) =>
							setTimeout(
								() =>
									reject(
										new Error(`Item processing timeout after ${itemTimeout}ms`),
									),
								itemTimeout,
							),
						);

						const workPromise = Promise.resolve(this.processItem(item));

						const p: Promise<void> = Promise.race([workPromise, timeoutPromise])
							.catch((error: Error) => {
								this.logger.error(
									`Error processing ${item.url}: ${error.message}`,
								);
								this.state.recordFailure();
							})
							.finally(() => {
								this.activeItems.delete(item.url);
								processingPromises.delete(p);
								if (this.sessionId && this.db) {
									removeQueueItem(this.db, this.sessionId, item.url);
								}
							});
						return p;
					})();

					processingPromises.add(task);
				} catch (err) {
					this.logger.error(
						`Error in queue processing: ${getErrorMessage(err)}`,
					);
					this.state.recordFailure();
				}
			}

			const currentScanned = this.state.stats.pagesScanned;
			if (currentScanned !== lastScannedCount) {
				lastProgressTime = now;
				lastScannedCount = currentScanned;
				stuckWarningCount = 0; // Reset on actual progress
			}

			if (now - lastProgressLog > progressLogInterval) {
				lastProgressLog = now;
				this.logger.info(
					`[Progress] Queue: ${this.queue.length - this.queueHead} | Active: ${this.activeCount} | Scanned: ${this.state.stats.pagesScanned} | Links: ${this.state.stats.linksFound}`,
				);
			}

			const timeSinceProgress = now - lastProgressTime;
			if (timeSinceProgress > stuckThreshold && this.activeCount > 0) {
				stuckWarningCount++;
				const activeUrls = [...this.activeItems].slice(0, 5).join(", ");
				this.logger.warn(
					`[Watchdog] No completions for ${Math.round(timeSinceProgress / 1000)}s (warning #${stuckWarningCount}) with ${this.activeCount} active items. ` +
						`Stuck items may include: ${activeUrls}...`,
				);

				if (timeSinceProgress > stuckForceClear) {
					this.logger.error(
						`[Watchdog] Force-clearing ${this.activeCount} stuck items after ${Math.round(stuckForceClear / 1000)}s`,
					);
					const stuckUrls = [...this.activeItems];
					this.activeItems.clear();
					for (const _ of stuckUrls) {
						this.state.recordFailure();
					}
					lastProgressTime = now;
					stuckWarningCount = 0;
				}
			}

			if (
				(this.activeCount > 0 || this.queueHead < this.queue.length) &&
				this.state.isActive
			) {
				const snapshot = this.state.snapshotQueueMetrics(
					this.queue.length - this.queueHead,
					this.activeCount,
				);
				this.socket.emit("queueStats", snapshot);
			}

			if (!this.state.isActive && this.activeCount > 0) {
				await Promise.race(processingPromises);
				continue;
			}

			const sleepDuration =
				deferredDelay === null
					? CRAWL_QUEUE_CONSTANTS.DEFAULT_SLEEP_MS
					: Math.max(
							Math.min(deferredDelay, this.options.crawlDelay),
							CRAWL_QUEUE_CONSTANTS.MIN_SLEEP_MS,
						);

			await sleep(sleepDuration);
		}

		if (processingPromises.size > 0) {
			await Promise.all(processingPromises);
		}

		if (this.state.isActive) {
			await this.onIdle();
		}
	}

	async awaitIdle(): Promise<void> {
		if (this.loopPromise) {
			await this.loopPromise;
		}
	}
}
