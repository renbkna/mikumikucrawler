import type { CrawlOptions } from "../../../shared/contracts/index.js";
import type { Logger } from "../../config/logging.js";
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
			if (this.queuedUrls.has(item.url)) {
				throw new Error(`Cannot restore duplicate queued URL: ${item.url}`);
			}
			this.state.restoreAdmission(item.url);
			this.state.restoreDomainAdmission(item.domain);
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
		const identity = getCrawlUrlIdentity(item.url);
		if ("error" in identity) {
			return false;
		}

		const domain = item.domain ?? identity.domainBudgetKey;
		return this.enqueueNormalized({
			url: identity.canonicalUrl,
			domain,
			depth: item.depth,
			retries: item.retries,
			availableAt: item.availableAt ?? Date.now(),
			parentUrl: item.parentUrl,
		});
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
			const delayKey = this.getDelayKey(candidate);

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

	markInterrupted(item: QueueItem): void {
		this.activeUrls.delete(item.url);
		this.logger.debug(`[Queue] Preserving active item for resume: ${item.url}`);
	}

	private getDelayKey(item: QueueItem): string {
		const identity = getCrawlUrlIdentity(item.url);
		return "error" in identity ? item.domain : identity.originKey;
	}

	deferPendingByDelayKey(getNextAllowedAt: (delayKey: string) => number): void {
		for (const item of this.pending) {
			const nextAllowedAt = getNextAllowedAt(this.getDelayKey(item));
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
