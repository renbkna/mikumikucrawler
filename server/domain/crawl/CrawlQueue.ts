import type { CrawlOptions } from "../../../shared/contracts/index.js";
import type { CrawlState } from "./CrawlState.js";
import { getCrawlUrlIdentity } from "./UrlPolicy.js";

export interface QueueItem {
	readonly url: string;
	readonly domain: string;
	readonly depth: number;
	readonly retries: number;
	readonly availableAt?: number;
	readonly parentUrl?: string;
}

interface QueuePersistence {
	enqueueMany(items: QueueItem[]): void;
	reschedule(item: QueueItem): void;
	clear(): void;
}

export class CrawlQueue {
	private readonly pending: QueueItem[] = [];
	private readonly queuedUrls = new Set<string>();
	private readonly activeItems = new Map<string, QueueItem>();
	private discarded = false;

	constructor(
		private readonly options: CrawlOptions,
		private readonly state: CrawlState,
		private readonly persistence: QueuePersistence,
	) {}

	get activeCount(): number {
		return this.activeItems.size;
	}

	get pendingCount(): number {
		return this.pending.length;
	}

	restore(records: readonly QueueItem[]): void {
		if (this.discarded) throw new Error("Cannot restore a discarded queue");
		const items = records.map((item) => Object.freeze({ ...item }));
		const targetIdentity = getCrawlUrlIdentity(this.options.target);
		if ("error" in targetIdentity) {
			throw new Error(`Cannot restore queue for invalid crawl target: ${this.options.target}`);
		}
		const restoredUrls = new Set<string>();
		for (const item of items) {
			const identity = getCrawlUrlIdentity(item.url);
			if (
				"error" in identity ||
				identity.canonicalUrl !== item.url ||
				identity.domainBudgetKey !== item.domain
			) {
				throw new Error(`Cannot restore invalid queued URL identity: ${item.url}`);
			}
			if (this.options.crawlMethod !== "full" && identity.originKey !== targetIdentity.originKey) {
				throw new Error(`Cannot restore external URL outside full crawl mode: ${item.url}`);
			}
			if (
				!Number.isSafeInteger(item.depth) ||
				item.depth < 0 ||
				item.depth > this.options.crawlDepth
			) {
				throw new Error(`Cannot restore queued depth outside crawl policy: ${item.depth}`);
			}
			if (
				!Number.isSafeInteger(item.retries) ||
				item.retries < 0 ||
				item.retries > this.options.retryLimit
			) {
				throw new Error(`Cannot restore queued retries outside crawl policy: ${item.retries}`);
			}
			if (this.queuedUrls.has(item.url) || restoredUrls.has(item.url)) {
				throw new Error(`Cannot restore duplicate queued URL: ${item.url}`);
			}
			restoredUrls.add(item.url);
		}

		this.state.restoreQueueAdmissions(items);
		for (const item of items) {
			this.pending.push(item);
			this.queuedUrls.add(item.url);
		}
	}

	enqueueNormalized(item: QueueItem): boolean {
		if (this.discarded) return false;
		if (item.retries !== 0) {
			throw new Error("New queue admissions must start without retries");
		}
		if (
			this.state.hasVisited(item.url) ||
			this.activeItems.has(item.url) ||
			this.queuedUrls.has(item.url)
		) {
			return false;
		}

		if (!this.state.canAdmit(item.url, item.domain)) {
			return false;
		}

		const queueItem: QueueItem = Object.freeze({
			...item,
			availableAt: item.availableAt ?? Date.now(),
		});

		this.persistence.enqueueMany([queueItem]);
		this.state.recordAdmission(queueItem.url, queueItem.domain);
		this.pending.push(queueItem);
		this.queuedUrls.add(queueItem.url);
		return true;
	}

	tryScheduleRetry(item: QueueItem, delayMs: number): boolean {
		this.requireActiveItem(item);
		if (this.discarded) return false;
		if (this.queuedUrls.has(item.url)) {
			throw new Error(`Retry already scheduled for active item: ${item.url}`);
		}
		const availableAt = Date.now() + delayMs;
		if (!Number.isFinite(delayMs) || delayMs < 0 || availableAt > Number.MAX_SAFE_INTEGER) {
			throw new Error("Retry delay must produce a finite, nonnegative safe timestamp");
		}
		if (item.retries >= this.options.retryLimit) return false;
		const retryItem: QueueItem = Object.freeze({
			...item,
			retries: item.retries + 1,
			availableAt,
		});

		this.persistence.reschedule(retryItem);
		this.pending.push(retryItem);
		this.queuedUrls.add(retryItem.url);
		return true;
	}

	nextReady(now = Date.now()): { item: QueueItem | null; waitMs: number } {
		if (this.pending.length === 0) {
			return { item: null, waitMs: 0 };
		}

		let minimumWait = Number.POSITIVE_INFINITY;
		const iterations = this.pending.length;

		for (let index = 0; index < iterations; index += 1) {
			let candidate = this.pending.shift();
			if (!candidate) {
				break;
			}
			this.queuedUrls.delete(candidate.url);
			const delayKey = candidate.domain;

			if (this.activeItems.has(candidate.url)) {
				this.pending.push(candidate);
				this.queuedUrls.add(candidate.url);
				continue;
			}

			const waitMs = Math.max(
				(candidate.availableAt ?? 0) - now,
				this.state.timeUntilDomainReady(delayKey, now),
			);
			if (waitMs > 0) {
				minimumWait = Math.min(minimumWait, waitMs);
				this.pending.push(candidate);
				this.queuedUrls.add(candidate.url);
				continue;
			}

			this.state.reserveDomain(delayKey, now);
			const nextAllowedAt = this.state.nextAllowedAtForDomain(delayKey);
			if (nextAllowedAt > (candidate.availableAt ?? 0)) {
				candidate = Object.freeze({ ...candidate, availableAt: nextAllowedAt });
				this.persistence.reschedule(candidate);
			}
			this.activeItems.set(candidate.url, candidate);
			this.deferPendingToDomainDelays();
			return { item: candidate, waitMs: 0 };
		}

		return {
			item: null,
			waitMs: Number.isFinite(minimumWait) ? minimumWait : this.options.crawlDelay,
		};
	}

	private requireActiveItem(item: QueueItem): void {
		if (this.activeItems.get(item.url) !== item) {
			throw new Error(`Queue item is not the current active attempt: ${item.url}`);
		}
	}

	markDone(item: QueueItem): void {
		this.requireActiveItem(item);
		this.activeItems.delete(item.url);
	}

	deferPendingToDomainDelays(): void {
		for (const [index, item] of this.pending.entries()) {
			const nextAllowedAt = this.state.nextAllowedAtForDomain(item.domain);
			if (nextAllowedAt <= (item.availableAt ?? 0)) {
				continue;
			}

			const deferred = Object.freeze({ ...item, availableAt: nextAllowedAt });
			this.persistence.reschedule(deferred);
			this.pending[index] = deferred;
		}
	}

	discard(): void {
		if (this.discarded) return;
		this.persistence.clear();
		this.discarded = true;
		this.pending.length = 0;
		this.queuedUrls.clear();
	}
}
