import type { CrawlCounters, CrawlOptions } from "../../../shared/contracts/index.js";
import { createEmptyCrawlCounters, isCrawlCounters } from "../../../shared/contracts/index.js";
import type { QueueStats } from "../../../shared/contracts/pageData.js";
import { DOMAIN_DELAY_CONSTANTS } from "../../constants.js";
import {
	type CommittedTerminal,
	deriveTerminalCounters,
	type TerminalOutcome,
} from "./completion.js";
import { shouldAdaptDomainDelay } from "./httpStatusPolicy.js";
import { getCrawlUrlIdentity } from "./UrlPolicy.js";

const FAILURE_CIRCUIT_BREAKER_THRESHOLD = 20;

interface CrawlStateHooks {
	onDomainStateChanged?: (record: DomainStateRecord) => void;
}

interface RestoredTerminalRecord {
	url: string;
	outcome: TerminalOutcome;
	domainBudgetCharged?: boolean;
	chargedDomain?: string | null;
}

interface QueueSnapshot {
	activeRequests: number;
	queueLength: number;
}

export interface DomainStateRecord {
	delayKey: string;
	delayMs: number;
	nextAllowedAt: number;
}

export class CrawlState {
	private readonly terminalUrls = new Set<string>();
	private readonly admittedDomains = new Map<string, string | undefined>();
	private readonly domainDelays = new Map<string, number>();
	private readonly domainNextAllowedAt = new Map<string, number>();
	private readonly domainPageCounts = new Map<string, number>();
	private readonly domainAdmissionCounts = new Map<string, number>();
	private readonly redirectReservations = new Map<string, string>();
	private readonly redirectReservationCounts = new Map<string, number>();
	private consecutiveFailures = 0;
	private stopRequested = false;
	private admissionCount: number;

	private readonly counters: CrawlCounters;
	private requestedStopReason: string | null = null;

	get stopReason(): string | null {
		return this.requestedStopReason;
	}

	constructor(
		private readonly options: CrawlOptions,
		initialCounters?: CrawlCounters,
		private readonly hooks: CrawlStateHooks = {},
		private readonly startedAtMs = Date.now(),
		initialDomainStates: DomainStateRecord[] = [],
	) {
		if (initialCounters !== undefined && !isCrawlCounters(initialCounters)) {
			throw new Error("Cannot restore crawl state from invalid counters");
		}
		this.counters = initialCounters ? { ...initialCounters } : createEmptyCrawlCounters();
		this.admissionCount = this.counters.pagesScanned;
		for (const record of initialDomainStates) {
			const delayMs = this.requireDomainDelay(record.delayMs);
			if (!Number.isSafeInteger(record.nextAllowedAt) || record.nextAllowedAt < 0) {
				throw new Error(`Invalid persisted next-allowed timestamp for ${record.delayKey}`);
			}
			this.domainDelays.set(record.delayKey, Math.max(delayMs, this.options.crawlDelay));
			this.domainNextAllowedAt.set(record.delayKey, record.nextAllowedAt);
		}
	}

	private requireDomainDelay(delayMs: number): number {
		if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > DOMAIN_DELAY_CONSTANTS.MAX_MS) {
			throw new Error(
				`Domain delay must be finite and between 0 and ${DOMAIN_DELAY_CONSTANTS.MAX_MS}ms`,
			);
		}
		return Math.floor(delayMs);
	}

	get isStopRequested(): boolean {
		return this.stopRequested;
	}

	hasPageCapacity(): boolean {
		return this.counters.pagesScanned < this.options.maxPages;
	}

	remainingAdmissionCapacity(): number {
		return Math.max(0, this.options.maxPages - this.admissionCount);
	}

	hasVisited(url: string): boolean {
		return this.terminalUrls.has(url);
	}

	restoreTerminals(records: RestoredTerminalRecord[]): void {
		const restoredUrls = new Set<string>();
		const restoredDomains = new Map<string, string>();
		for (const record of records) {
			if (this.terminalUrls.has(record.url) || restoredUrls.has(record.url)) {
				throw new Error(`Cannot restore duplicate terminal URL: ${record.url}`);
			}
			const identity = getCrawlUrlIdentity(record.url);
			if ("error" in identity || identity.canonicalUrl !== record.url) {
				throw new Error(`Cannot restore invalid terminal URL: ${record.url}`);
			}
			const chargedDomain = record.chargedDomain ?? identity.domainBudgetKey;
			const chargedIdentity = getCrawlUrlIdentity(`http://${chargedDomain}/`);
			if (
				"error" in chargedIdentity ||
				chargedIdentity.domainBudgetKey !== chargedDomain ||
				chargedIdentity.hostname !== chargedDomain
			) {
				throw new Error(`Cannot restore invalid charged domain: ${chargedDomain}`);
			}
			restoredUrls.add(record.url);
			restoredDomains.set(record.url, chargedDomain);
		}
		if (records.length !== this.counters.pagesScanned) {
			throw new Error("Persisted terminal rows must match the durable terminal counter");
		}
		this.restoreAdmissions(
			records.map((record) => ({
				url: record.url,
				...(record.domainBudgetCharged
					? { domain: restoredDomains.get(record.url) as string }
					: {}),
			})),
			false,
		);

		for (const record of records) {
			this.terminalUrls.add(record.url);
			this.observeOutcome(record.outcome);

			if (!record.domainBudgetCharged) {
				continue;
			}

			const domain = restoredDomains.get(record.url) as string;
			this.recordDomainPage(domain);
		}
	}

	restoreQueueAdmissions(records: ReadonlyArray<{ url: string; domain: string }>): void {
		this.restoreAdmissions(records, true);
	}

	private restoreAdmissions(
		records: ReadonlyArray<{ url: string; domain?: string }>,
		consumeGlobalBudget: boolean,
	): void {
		const restoredUrls = new Set<string>();
		const restoredDomainCounts = new Map<string, number>();
		for (const record of records) {
			if (this.admittedDomains.has(record.url) || restoredUrls.has(record.url)) {
				throw new Error(`Cannot restore duplicate admitted URL: ${record.url}`);
			}
			if (consumeGlobalBudget && this.admissionCount + restoredUrls.size >= this.options.maxPages) {
				throw new Error(`Restored queue exceeds the crawl page budget at ${record.url}`);
			}
			restoredUrls.add(record.url);

			if (record.domain === undefined || this.options.maxPagesPerDomain <= 0) continue;
			const restoredCount = (restoredDomainCounts.get(record.domain) ?? 0) + 1;
			if (
				(this.domainAdmissionCounts.get(record.domain) ?? 0) + restoredCount >
				this.options.maxPagesPerDomain
			) {
				throw new Error(`Restored queue exceeds the domain page budget for ${record.domain}`);
			}
			restoredDomainCounts.set(record.domain, restoredCount);
		}

		for (const record of records) this.admittedDomains.set(record.url, record.domain);
		if (consumeGlobalBudget) this.admissionCount += restoredUrls.size;
		for (const [domain, count] of restoredDomainCounts) {
			this.domainAdmissionCounts.set(domain, (this.domainAdmissionCounts.get(domain) ?? 0) + count);
		}
	}

	canAdmit(url: string, domain: string): boolean {
		if (this.admittedDomains.has(url) || this.admissionCount >= this.options.maxPages) {
			return false;
		}
		const domainBudget = this.options.maxPagesPerDomain;
		const occupied =
			(this.domainAdmissionCounts.get(domain) ?? 0) +
			(this.redirectReservationCounts.get(domain) ?? 0);
		return domainBudget <= 0 || occupied < domainBudget;
	}

	recordAdmission(url: string, domain: string): void {
		if (!this.canAdmit(url, domain)) {
			throw new Error(`Cannot record unavailable crawl admission: ${url}`);
		}
		this.admittedDomains.set(url, domain);
		this.admissionCount += 1;
		this.restoreDomainAdmission(domain);
	}

	tryReserveRedirectDomain(url: string, domain: string): boolean {
		const sourceDomain = this.requirePendingAdmission(url);
		if (domain === sourceDomain) {
			this.releaseRedirectReservation(url);
			return true;
		}
		const current = this.redirectReservations.get(url);
		if (current === domain) return true;
		if (this.options.maxPagesPerDomain > 0) {
			const occupied =
				(this.domainAdmissionCounts.get(domain) ?? 0) +
				(this.redirectReservationCounts.get(domain) ?? 0);
			if (occupied >= this.options.maxPagesPerDomain) return false;
		}
		if (current) this.decrementRedirectReservation(current);
		this.redirectReservations.set(url, domain);
		this.redirectReservationCounts.set(
			domain,
			(this.redirectReservationCounts.get(domain) ?? 0) + 1,
		);
		return true;
	}

	/** Release attempt-scoped reservations while retaining the queued admission for retry/resume. */
	releaseAttempt(url: string): void {
		this.releaseRedirectReservation(url);
	}

	private releaseRedirectReservation(url: string): void {
		const domain = this.redirectReservations.get(url);
		if (!domain) return;
		this.redirectReservations.delete(url);
		this.decrementRedirectReservation(domain);
	}

	private settleDomainAdmission(url: string, fromDomain: string, chargedDomain: string): void {
		this.releaseRedirectReservation(url);
		if (fromDomain === chargedDomain || this.options.maxPagesPerDomain <= 0) return;
		this.releaseDomainAdmission(fromDomain);
		this.restoreDomainAdmission(chargedDomain);
	}

	private decrementRedirectReservation(domain: string): void {
		const count = this.redirectReservationCounts.get(domain) ?? 0;
		if (count <= 1) this.redirectReservationCounts.delete(domain);
		else this.redirectReservationCounts.set(domain, count - 1);
	}

	requestStop(reason: string, options: { overrideReason?: boolean } = {}): void {
		this.stopRequested = true;
		this.requestedStopReason =
			options.overrideReason || this.stopReason === null ? reason : this.stopReason;
	}

	setDomainDelay(domain: string, delayMs: number, now = Date.now()): void {
		const effectiveDelay = Math.max(this.requireDomainDelay(delayMs), this.options.crawlDelay);
		this.domainDelays.set(domain, effectiveDelay);
		const nextAllowedAt = Math.max(this.domainNextAllowedAt.get(domain) ?? 0, now + effectiveDelay);
		this.domainNextAllowedAt.set(domain, nextAllowedAt);
		this.emitDomainState(domain);
	}

	getDomainDelay(domain: string): number {
		return Math.max(this.domainDelays.get(domain) ?? 0, this.options.crawlDelay);
	}

	timeUntilDomainReady(domain: string, now = Date.now()): number {
		const nextAllowedAt = this.domainNextAllowedAt.get(domain) ?? 0;
		return Math.max(nextAllowedAt - now, 0);
	}

	nextAllowedAtForDomain(domain: string): number {
		return this.domainNextAllowedAt.get(domain) ?? 0;
	}

	reserveDomain(domain: string, now = Date.now()): void {
		this.domainNextAllowedAt.set(domain, now + this.getDomainDelay(domain));
		this.emitDomainState(domain);
	}

	adaptDomainDelay(domain: string, statusCode: number, retryAfterMs?: number): void {
		if (!shouldAdaptDomainDelay(statusCode)) {
			return;
		}

		const currentDelay = this.getDomainDelay(domain);
		const proposedDelay =
			statusCode === 403
				? Math.max(currentDelay * 2, this.options.crawlDelay)
				: Math.max(currentDelay, retryAfterMs ?? currentDelay * 2);
		const nextDelay = Number.isFinite(proposedDelay)
			? Math.min(proposedDelay, DOMAIN_DELAY_CONSTANTS.MAX_MS)
			: DOMAIN_DELAY_CONSTANTS.MAX_MS;
		this.setDomainDelay(domain, nextDelay);
	}

	private recordDomainPage(domain: string): void {
		this.domainPageCounts.set(domain, (this.domainPageCounts.get(domain) ?? 0) + 1);
	}

	private restoreDomainAdmission(domain: string): void {
		if (this.options.maxPagesPerDomain <= 0) return;
		const nextCount = (this.domainAdmissionCounts.get(domain) ?? 0) + 1;
		if (nextCount > this.options.maxPagesPerDomain) {
			throw new Error(`Cannot exceed the domain page budget for ${domain}`);
		}
		this.domainAdmissionCounts.set(domain, nextCount);
	}

	private releaseDomainAdmission(domain: string): void {
		if (this.options.maxPagesPerDomain <= 0) return;
		const admitted = this.domainAdmissionCounts.get(domain) ?? 0;
		if (admitted < 1) {
			throw new Error(`Cannot release missing domain admission: ${domain}`);
		}
		if (admitted === 1) {
			this.domainAdmissionCounts.delete(domain);
			return;
		}
		this.domainAdmissionCounts.set(domain, admitted - 1);
	}

	isDomainBudgetExceeded(domain: string): boolean {
		const budget = this.options.maxPagesPerDomain;
		if (budget <= 0) return false;
		return (this.domainPageCounts.get(domain) ?? 0) >= budget;
	}

	private emitDomainState(delayKey: string): void {
		this.hooks.onDomainStateChanged?.({
			delayKey,
			delayMs: this.getDomainDelay(delayKey),
			nextAllowedAt: this.nextAllowedAtForDomain(delayKey),
		});
	}

	private requirePendingAdmission(url: string): string {
		if (this.terminalUrls.has(url)) {
			throw new Error(`Cannot complete already-terminal URL: ${url}`);
		}
		const domain = this.admittedDomains.get(url);
		if (domain === undefined) throw new Error(`Missing crawl admission: ${url}`);
		return domain;
	}

	applyCommittedTerminal(url: string, outcome: TerminalOutcome, commit: CommittedTerminal): void {
		const sourceDomain = this.requirePendingAdmission(url);
		const nextCounters = deriveTerminalCounters(this.counters, outcome, commit.effects);
		if (!Bun.deepEquals(nextCounters, commit.counters, true)) {
			throw new Error("Runtime counters diverged from the committed crawl aggregate");
		}
		const { chargedDomain } = commit;
		if (chargedDomain !== null) {
			const identity = getCrawlUrlIdentity(`http://${chargedDomain}/`);
			if ("error" in identity || identity.hostname !== chargedDomain) {
				throw new Error(`Invalid committed domain: ${chargedDomain}`);
			}
			if (
				chargedDomain !== sourceDomain &&
				this.options.maxPagesPerDomain > 0 &&
				(this.domainAdmissionCounts.get(chargedDomain) ?? 0) >= this.options.maxPagesPerDomain
			) {
				throw new Error(`Cannot exceed the domain page budget for ${chargedDomain}`);
			}
		}

		// Validate all durable facts before changing any projection of the completion.
		if (chargedDomain === null) {
			this.releaseRedirectReservation(url);
			this.releaseDomainAdmission(sourceDomain);
		} else {
			this.settleDomainAdmission(url, sourceDomain, chargedDomain);
			this.recordDomainPage(chargedDomain);
		}
		this.terminalUrls.add(url);
		Object.assign(this.counters, nextCounters);
		this.observeOutcome(outcome);
	}

	private observeOutcome(outcome: TerminalOutcome): void {
		this.consecutiveFailures = outcome === "failure" ? this.consecutiveFailures + 1 : 0;
		if (this.consecutiveFailures >= FAILURE_CIRCUIT_BREAKER_THRESHOLD) {
			this.requestStop(
				`Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures`,
			);
		}
	}

	snapshotCounters(): CrawlCounters {
		return { ...this.counters };
	}

	buildProgress(queue: QueueSnapshot) {
		const snapshot = this.snapshotCounters();
		const elapsedSeconds = Math.max(Math.floor((Date.now() - this.startedAtMs) / 1000), 0);
		const pagesPerSecond =
			elapsedSeconds > 0 ? Number((snapshot.pagesScanned / elapsedSeconds).toFixed(2)) : 0;
		const queueStats: QueueStats = {
			...queue,
			elapsedTime: elapsedSeconds,
			pagesPerSecond,
		};

		return {
			counters: snapshot,
			queue: queueStats,
			stopReason: this.stopReason,
		};
	}
}
