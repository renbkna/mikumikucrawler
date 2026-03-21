import type { Logger } from "../../config/logging.js";
import type { CrawlOptions } from "../../contracts/crawl.js";
import { normalizeHttpUrl } from "../../../shared/url.js";
import type { CrawlState } from "./CrawlState.js";

export interface QueueItem {
	url: string;
	domain: string;
	depth: number;
	retries: number;
	availableAt?: number;
	parentUrl?: string;
}

interface QueuePersistence {
	enqueueMany(items: QueueItem[]): void;
	reschedule(item: QueueItem): void;
	remove(url: string): void;
	clear(): void;
}

export class CrawlQueue {
	private readonly pending: QueueItem[] = [];
	private readonly queuedUrls = new Set<string>();
	private readonly activeUrls = new Set<string>();
	private readonly rescheduledUrls = new Set<string>();

	constructor(
		private readonly options: CrawlOptions,
		private readonly state: CrawlState,
		private readonly logger: Logger,
		private readonly persistence: QueuePersistence,
	) {}

	get activeCount(): number {
		return this.activeUrls.size;
	}

	get pendingCount(): number {
		return this.pending.length;
	}

	restore(items: QueueItem[]): void {
		for (const item of items) {
			if (this.queuedUrls.has(item.url)) continue;
			this.pending.push(item);
			this.queuedUrls.add(item.url);
		}
	}

	enqueue(
		item: Omit<QueueItem, "domain" | "availableAt"> & {
			url: string;
			domain?: string;
			availableAt?: number;
		},
	): boolean {
		const normalized = normalizeHttpUrl(item.url);
		if ("error" in normalized || !normalized.url) {
			return false;
		}

		const url = normalized.url;
		if (
			this.state.hasVisited(url) ||
			this.activeUrls.has(url) ||
			this.queuedUrls.has(url)
		) {
			return false;
		}

		const domain = item.domain ?? new URL(url).hostname;
		const queueItem: QueueItem = {
			url,
			domain,
			depth: item.depth,
			retries: item.retries,
			availableAt: item.availableAt ?? Date.now(),
			parentUrl: item.parentUrl,
		};

		this.pending.push(queueItem);
		this.queuedUrls.add(url);
		this.persistence.enqueueMany([queueItem]);
		return true;
	}

	scheduleRetry(item: QueueItem, delayMs: number): void {
		const retryItem: QueueItem = {
			...item,
			retries: item.retries + 1,
			availableAt: Date.now() + delayMs,
		};

		this.pending.push(retryItem);
		this.queuedUrls.add(retryItem.url);
		this.rescheduledUrls.add(retryItem.url);
		this.persistence.reschedule(retryItem);
	}

	clearRetryTimers(): void {
		// Retries are modeled as delayed persisted queue items instead of
		// process-local timers, so interruption does not discard future work.
	}

	nextReady(now = Date.now()): { item: QueueItem | null; waitMs: number } {
		if (this.pending.length === 0) {
			return { item: null, waitMs: 0 };
		}

		let minimumWait = Number.POSITIVE_INFINITY;
		const iterations = this.pending.length;

		for (let index = 0; index < iterations; index += 1) {
			const candidate = this.pending.shift();
			if (!candidate) {
				break;
			}
			this.queuedUrls.delete(candidate.url);

			const waitMs = Math.max(
				(candidate.availableAt ?? 0) - now,
				this.state.timeUntilDomainReady(candidate.domain, now),
			);
			if (waitMs > 0) {
				minimumWait = Math.min(minimumWait, waitMs);
				this.pending.push(candidate);
				this.queuedUrls.add(candidate.url);
				continue;
			}

			this.activeUrls.add(candidate.url);
			this.state.reserveDomain(candidate.domain, now);
			return { item: candidate, waitMs: 0 };
		}

		return {
			item: null,
			waitMs: Number.isFinite(minimumWait)
				? minimumWait
				: this.options.crawlDelay,
		};
	}

	markDone(item: QueueItem): void {
		this.activeUrls.delete(item.url);
		if (this.rescheduledUrls.delete(item.url)) {
			return;
		}
		this.persistence.remove(item.url);
	}

	markInterrupted(item: QueueItem): void {
		this.activeUrls.delete(item.url);
		this.logger.debug(`[Queue] Preserving active item for resume: ${item.url}`);
	}

	clearPending(): void {
		this.pending.length = 0;
		this.queuedUrls.clear();
	}

	clearPersisted(): void {
		this.persistence.clear();
	}
}
