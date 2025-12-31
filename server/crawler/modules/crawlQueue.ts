import { URL } from "node:url";
import type { Logger } from "../../config/logging.js";
import { CRAWL_QUEUE_CONSTANTS } from "../../constants.js";
import type {
	CrawlerSocket,
	QueueItem,
	SanitizedCrawlOptions,
} from "../../types.js";
import { getErrorMessage } from "../../utils/helpers.js";
import type { CrawlState } from "./crawlState.js";

/**
 * Internal utility to pause execution for a given duration.
 */
const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

interface CrawlQueueOptions {
	options: SanitizedCrawlOptions;
	state: CrawlState;
	logger: Logger;
	socket: CrawlerSocket;
	processItem: (item: QueueItem) => Promise<void>;
	onIdle?: () => Promise<void>;
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
	/** Tracks active items by URL for atomic add/remove (avoids race conditions) */
	private readonly activeItems: Set<string>;
	private readonly retryTimers: Set<ReturnType<typeof setTimeout>>;
	private loopPromise: Promise<void> | null;

	constructor({
		options,
		state,
		logger,
		socket,
		processItem,
		onIdle = async () => {},
	}: CrawlQueueOptions) {
		this.options = options;
		this.state = state;
		this.logger = logger;
		this.socket = socket;
		this.processItem = processItem;
		this.onIdle = onIdle;

		this.queue = [];
		this.activeItems = new Set();
		this.retryTimers = new Set();
		this.loopPromise = null;
	}

	/** Returns the current number of actively processing items */
	get activeCount(): number {
		return this.activeItems.size;
	}

	/**
	 * Adds a new item to the queue if it hasn't been visited yet.
	 */
	enqueue(item: QueueItem): void {
		if (this.state.hasVisited(item.url)) return;
		this.queue.push(item);
	}

	/**
	 * Schedules a retry for an item after a specified delay.
	 */
	scheduleRetry(item: QueueItem, delay: number): void {
		const timer = setTimeout(() => {
			this.retryTimers.delete(timer);
			if (!this.state.isActive) return;
			this.enqueue(item);
		}, delay);

		this.retryTimers.add(timer);
	}

	/**
	 * Cancels all pending retry timers.
	 */
	clearRetries(): void {
		for (const timer of this.retryTimers) {
			clearTimeout(timer);
		}
		this.retryTimers.clear();
	}

	/**
	 * Starts the processing loop and returns a promise that resolves when the queue is empty and idle.
	 */
	start(): Promise<void> {
		this.loopPromise ??= this.loop();
		return this.loopPromise;
	}

	/** Main loop that processes the queue while respecting rate limits and domain etiquette. */
	private async loop(): Promise<void> {
		const domainProcessing = new Map<string, number>();

		while (
			(this.queue.length > 0 || this.activeCount > 0) &&
			this.state.isActive
		) {
			let deferredDelay: number | null = null;

			if (
				domainProcessing.size >
				CRAWL_QUEUE_CONSTANTS.DOMAIN_CACHE_CLEANUP_THRESHOLD
			) {
				const now = Date.now();
				for (const [domain, nextAllowed] of domainProcessing) {
					if (
						now >
						nextAllowed + CRAWL_QUEUE_CONSTANTS.DOMAIN_ENTRY_EXPIRY_MS
					) {
						domainProcessing.delete(domain);
					}
				}
			}

			while (
				this.activeCount < this.options.maxConcurrentRequests &&
				this.queue.length > 0 &&
				this.state.isActive
			) {
				const item = this.queue.shift();
				if (!item) break;

				try {
					const url = new URL(item.url);
					const domain = url.hostname;

					const nextAllowed = domainProcessing.get(domain) || 0;
					const now = Date.now();
					const domainDelay = this.state.getDomainDelay(domain);

					if (now < nextAllowed) {
						const waitTime = nextAllowed - now;
						deferredDelay =
							deferredDelay === null
								? waitTime
								: Math.min(deferredDelay, waitTime);
						this.queue.push(item);
						if (this.queue.length === 1) break;
						continue;
					}

					domainProcessing.set(domain, now + domainDelay);

					// Use Set for atomic tracking (avoids race conditions with counter)
					this.activeItems.add(item.url);
					Promise.resolve(this.processItem(item))
						.catch((error: Error) => {
							this.logger.error(`Error in queue processing: ${error.message}`);
							this.state.recordFailure();
						})
						.finally(() => {
							this.activeItems.delete(item.url);
						});
				} catch (err) {
					this.logger.error(
						`Error in queue processing: ${getErrorMessage(err)}`,
					);
					this.state.recordFailure();
				}
			}

			if (
				(this.activeCount > 0 || this.queue.length > 0) &&
				this.state.isActive
			) {
				const snapshot = this.state.snapshotQueueMetrics(
					this.queue.length,
					this.activeCount,
				);
				this.socket.emit("queueStats", snapshot);
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

		if (this.state.isActive) {
			await this.onIdle();
		}
	}

	/**
	 * Returns a promise that resolves when the current queue processing is complete.
	 */
	async awaitIdle(): Promise<void> {
		if (this.loopPromise) {
			await this.loopPromise;
		}
	}
}
