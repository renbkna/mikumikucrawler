import { URL } from "node:url";
import type { Socket } from "socket.io";
import type { Logger } from "winston";
import type { QueueItem, SanitizedCrawlOptions } from "../../types.js";
import type { CrawlState } from "./crawlState.js";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

interface CrawlQueueOptions {
	options: SanitizedCrawlOptions;
	state: CrawlState;
	logger: Logger;
	socket: Socket;
	processItem: (item: QueueItem) => Promise<void>;
	onIdle?: () => Promise<void>;
}

export class CrawlQueue {
	private readonly options: SanitizedCrawlOptions;
	private readonly state: CrawlState;
	private readonly logger: Logger;
	private readonly socket: Socket;
	public processItem: (item: QueueItem) => Promise<void>;
	private readonly onIdle: () => Promise<void>;
	private readonly queue: QueueItem[];
	private activeCount: number;
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
		this.activeCount = 0;
		this.retryTimers = new Set();
		this.loopPromise = null;
	}

	enqueue(item: QueueItem): void {
		if (this.state.hasVisited(item.url)) {
			return;
		}
		this.queue.push(item);
	}

	scheduleRetry(item: QueueItem, delay: number): void {
		const timer = setTimeout(() => {
			this.retryTimers.delete(timer);
			if (!this.state.isActive) {
				return;
			}
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

	start(): Promise<void> {
		this.loopPromise ??= this.loop();
		return this.loopPromise;
	}

	private async loop(): Promise<void> {
		const domainProcessing = new Map<string, number>();
		const DOMAIN_CACHE_CLEANUP_THRESHOLD = 500;
		const DOMAIN_ENTRY_EXPIRY_MS = 60000; // 1 minute

		while (
			(this.queue.length > 0 || this.activeCount > 0) &&
			this.state.isActive
		) {
			let deferredDelay: number | null = null;

			// Periodically clean up old domain entries to prevent unbounded growth
			if (domainProcessing.size > DOMAIN_CACHE_CLEANUP_THRESHOLD) {
				const now = Date.now();
				for (const [domain, nextAllowed] of domainProcessing) {
					if (now > nextAllowed + DOMAIN_ENTRY_EXPIRY_MS) {
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
				if (!item) {
					break;
				}

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
						if (this.queue.length === 1) {
							break;
						}
						continue;
					}

					domainProcessing.set(domain, now + domainDelay);

					this.activeCount += 1;
					Promise.resolve(this.processItem(item))
						.catch((error: Error) => {
							this.logger.error(`Error in queue processing: ${error.message}`);
							this.state.recordFailure();
						})
						.finally(() => {
							this.activeCount = Math.max(0, this.activeCount - 1);
						});
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					this.logger.error(`Error in queue processing: ${message}`);
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
				this.socket.volatile.emit("queueStats", snapshot);
			}

			const sleepDuration =
				deferredDelay === null
					? 100
					: Math.max(Math.min(deferredDelay, this.options.crawlDelay), 50);

			await sleep(sleepDuration);
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
