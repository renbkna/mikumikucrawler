import type { CrawlOptions } from "../../../shared/contracts/index.js";
import type { CrawlState } from "./CrawlState.js";
import { getCrawlUrlIdentity } from "./UrlPolicy.js";

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
	clear(): void;
}

export class CrawlQueue {
	private readonly pending: QueueItem[] = [];
	private readonly queuedUrls = new Set<string>();
	private readonly activeUrls = new Set<string>();

	constructor(
		private readonly options: CrawlOptions,
		private readonly state: CrawlState,
		private readonly persistence: QueuePersistence,
	) {}

	get activeCount(): number {
		return this.activeUrls.size;
	}

	get pendingCount(): number {
		return this.pending.length;
	}

	restore(items: QueueItem[]): void {
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
		if (
			this.state.hasVisited(item.url) ||
			this.activeUrls.has(item.url) ||
			this.queuedUrls.has(item.url)
		) {
			return false;
		}

		if (!this.state.canAdmit(item.url, item.domain)) {
			return false;
		}

		const queueItem: QueueItem = {
			...item,
			availableAt: item.availableAt ?? Date.now(),
		};

		this.persistence.enqueueMany([queueItem]);
		this.state.recordAdmission(queueItem.url, queueItem.domain);
		this.pending.push(queueItem);
		this.queuedUrls.add(queueItem.url);
		return true;
	}

	scheduleRetry(item: QueueItem, delayMs: number): void {
		const retryItem: QueueItem = {
			...item,
			retries: item.retries + 1,
			availableAt: Date.now() + delayMs,
		};

		this.persistence.reschedule(retryItem);
		this.pending.push(retryItem);
		this.queuedUrls.add(retryItem.url);
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
			const delayKey = candidate.domain;

			if (this.activeUrls.has(candidate.url)) {
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

			this.activeUrls.add(candidate.url);
			this.state.reserveDomain(delayKey, now);
			const nextAllowedAt = this.state.nextAllowedAtForDomain(delayKey);
			if (nextAllowedAt > (candidate.availableAt ?? 0)) {
				this.persistence.reschedule({ ...candidate, availableAt: nextAllowedAt });
				candidate.availableAt = nextAllowedAt;
			}
			this.deferPendingByDelayKey((pendingDelayKey) =>
				this.state.nextAllowedAtForDomain(pendingDelayKey),
			);
			return { item: candidate, waitMs: 0 };
		}

		return {
			item: null,
			waitMs: Number.isFinite(minimumWait) ? minimumWait : this.options.crawlDelay,
		};
	}

	markDone(item: QueueItem): void {
		this.activeUrls.delete(item.url);
	}

	deferPendingByDelayKey(getNextAllowedAt: (delayKey: string) => number): void {
		for (const item of this.pending) {
			const nextAllowedAt = getNextAllowedAt(item.domain);
			if (nextAllowedAt <= (item.availableAt ?? 0)) {
				continue;
			}

			this.persistence.reschedule({ ...item, availableAt: nextAllowedAt });
			item.availableAt = nextAllowedAt;
		}
	}

	clearPending(): void {
		this.pending.length = 0;
		this.queuedUrls.clear();
	}

	clearPersisted(): void {
		this.persistence.clear();
	}
}
