import type { Logger } from "../../config/logging.js";
import type { CrawlOptions } from "../../contracts/crawl.js";
import { normalizeHttpUrl } from "../../../shared/url.js";
import type { CrawlState } from "./CrawlState.js";

export interface QueueItem {
	url: string;
	domain: string;
	depth: number;
	retries: number;
	parentUrl?: string;
}

interface QueuePersistence {
	enqueueMany(items: QueueItem[]): void;
	remove(url: string): void;
	clear(): void;
}

export class CrawlQueue {
	private readonly pending: QueueItem[] = [];
	private readonly queuedUrls = new Set<string>();
	private readonly activeUrls = new Set<string>();
	private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

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
		item: Omit<QueueItem, "domain"> & { url: string; domain?: string },
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
			parentUrl: item.parentUrl,
		};

		this.pending.push(queueItem);
		this.queuedUrls.add(url);
		this.persistence.enqueueMany([queueItem]);
		return true;
	}

	scheduleRetry(item: QueueItem, delayMs: number): void {
		const timer = setTimeout(() => {
			this.retryTimers.delete(timer);
			this.enqueue({
				url: item.url,
				domain: item.domain,
				depth: item.depth,
				retries: item.retries + 1,
				parentUrl: item.parentUrl,
			});
		}, delayMs);

		this.retryTimers.add(timer);
	}

	clearRetryTimers(): void {
		for (const timer of this.retryTimers) {
			clearTimeout(timer);
		}
		this.retryTimers.clear();
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

			const waitMs = this.state.timeUntilDomainReady(candidate.domain, now);
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
