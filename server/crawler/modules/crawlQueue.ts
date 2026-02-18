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
 * Uses Bun's native sleep for better performance.
 */
const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

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
	/** O(1) dequeue using head pointer instead of O(n) Array.shift() */
	private queueHead = 0;
	/** Tracks active items by URL for atomic add/remove (avoids race conditions) */
	private readonly activeItems: Set<string>;
	/** Tracks items currently in the queue to prevent duplicates */
	private readonly queuedUrls: Set<string>;
	private readonly retryTimers: Set<ReturnType<typeof setTimeout>>;
	/** Last time domain entries were cleaned up (for lazy cleanup every 5s) */
	private lastDomainCleanup = 0;
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
		this.queuedUrls = new Set();
		this.retryTimers = new Set();
		this.loopPromise = null;
	}

	/** Returns the current number of actively processing items */
	get activeCount(): number {
		return this.activeItems.size;
	}

	/**
	 * Adds a new item to the queue if it hasn't been visited yet.
	 * Pre-parses the domain to avoid repeated URL parsing in the hot loop.
	 */
	enqueue(item: Omit<QueueItem, "domain"> & { url: string }): void {
		if (
			this.state.hasVisited(item.url) ||
			this.activeItems.has(item.url) ||
			this.queuedUrls.has(item.url)
		) {
			return;
		}

		// Pre-parse domain at enqueue time to avoid expensive URL parsing in hot loop
		const domain = new URL(item.url).hostname;

		this.queuedUrls.add(item.url);
		this.queue.push({ ...item, domain });
	}

	/**
	 * Schedules a retry for an item after a specified delay.
	 */
	scheduleRetry(item: QueueItem, delay: number): void {
		const timer = setTimeout(() => {
			this.retryTimers.delete(timer);
			if (!this.state.isActive) return;
			// Force re-queue even if it was previously tracked, as we need to retry
			this.queuedUrls.delete(item.url);
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

	/**
	 * Main processing loop.
	 *
	 * Implements a "polite" crawling strategy:
	 * 1. Respects per-domain delays (Robots.txt or config).
	 * 2. Manages concurrency limits.
	 * 3. Handles queue draining and idle states.
	 *
	 * Uses a non-blocking delay system where we calculate the next allowed time
	 * for a domain and sleep effectively.
	 */
	private async loop(): Promise<void> {
		const domainProcessing = new Map<string, number>();
		// Track all active promises so we can await them on shutdown
		const processingPromises = new Set<Promise<void>>();

		while (
			(this.queueHead < this.queue.length || this.activeCount > 0) &&
			(this.state.isActive || this.activeCount > 0) // Keep looping if we have active items to drain
		) {
			// If stopped, just wait for active items to finish
			if (!this.state.isActive && this.queueHead < this.queue.length) {
				this.queue.length = 0; // Clear pending queue
				this.queueHead = 0;
				this.queuedUrls.clear();
			}

			let deferredDelay: number | null = null;

			// Lazy cleanup: Only scan domain entries every 5 seconds instead of every tick
			// This reduces O(domains) work to O(1) per iteration with periodic cleanup
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

			// Periodically compact queue to prevent unbounded growth from processed items
			// This maintains O(1) dequeue while preventing memory leak from processed head
			if (this.queueHead > CRAWL_QUEUE_CONSTANTS.QUEUE_COMPACTION_THRESHOLD) {
				this.queue.splice(0, this.queueHead);
				this.queueHead = 0;
			}

			// Snapshot available items before entering the inner loop.
			// Used to detect when every item in the current window has been
			// deferred (domain cooling) so we can break and let the outer
			// await sleep() run instead of spinning forever.
			const itemsAvailableNow = this.queue.length - this.queueHead;
			let deferredThisPass = 0;

			while (
				this.activeCount < this.options.maxConcurrentRequests &&
				this.queueHead < this.queue.length &&
				this.state.isActive
			) {
				// O(1) dequeue using head pointer instead of O(n) Array.shift()
				const item = this.queue[this.queueHead++];
				if (!item) break;
				this.queuedUrls.delete(item.url);

				try {
					// Domain is now pre-parsed at enqueue time - no expensive URL parsing here
					const domain = item.domain;

					const nextAllowed = domainProcessing.get(domain) || 0;
					const domainDelay = this.state.getDomainDelay(domain);

					// If this domain is still cooling down, push back to queue and calculate wait
					if (now < nextAllowed) {
						const waitTime = nextAllowed - now;
						deferredDelay =
							deferredDelay === null
								? waitTime
								: Math.min(deferredDelay, waitTime);

						// Re-queue safely
						this.queue.push(item);
						this.queuedUrls.add(item.url);

						deferredThisPass++;
						// Break as soon as every item in the current window has been
						// tried and pushed back due to domain cooldown.  Without this,
						// both queueHead and queue.length grow by 1 on every iteration
						// keeping the gap constant and creating an infinite busy-loop
						// that starves the outer `await sleep()` call.
						if (deferredThisPass >= itemsAvailableNow || this.queue.length === 1) break;
						continue;
					}

					// Successfully dispatching — reset the deferred counter so a mix
					// of ready and cooling items from different domains works correctly.
					deferredThisPass = 0;
					domainProcessing.set(domain, now + domainDelay);

					// Use Set for atomic tracking (avoids race conditions with counter)
					this.activeItems.add(item.url);

					// Wrap in a helper so `task` can be declared as `const`.  The
					// `finally` callback captures the resolved reference via the
					// closure returned by the IIFE, which is always assigned before
					// the microtask queue drains.
					const task = (() => {
						const p: Promise<void> = Promise.resolve(this.processItem(item))
							.catch((error: Error) => {
								this.logger.error(
									`Error in queue processing: ${error.message}`,
								);
								this.state.recordFailure();
							})
							.finally(() => {
								this.activeItems.delete(item.url);
								processingPromises.delete(p);
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

			// If we are shutting down, just wait for the next task to finish
			if (!this.state.isActive && this.activeCount > 0) {
				await Promise.race(processingPromises);
				continue;
			}

			// Dynamic sleep: Wait only as long as needed for the next domain slot,
			// or default sleep if nothing specific is blocking.
			const sleepDuration =
				deferredDelay === null
					? CRAWL_QUEUE_CONSTANTS.DEFAULT_SLEEP_MS
					: Math.max(
							Math.min(deferredDelay, this.options.crawlDelay),
							CRAWL_QUEUE_CONSTANTS.MIN_SLEEP_MS,
						);

			await sleep(sleepDuration);
		}

		// Ensure everything is truly done
		if (processingPromises.size > 0) {
			await Promise.all(processingPromises);
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
