import type { CrawlCounters, CrawlOptions } from "../../../shared/contracts/index.js";
import { createEmptyCrawlCounters, isCrawlCounters } from "../../../shared/contracts/index.js";
import type { QueueStats } from "../../../shared/contracts/pageData.js";
import { kilobytesToBytes } from "../../../shared/text.js";
import { DOMAIN_DELAY_CONSTANTS } from "../../constants.js";
import { shouldAdaptDomainDelay } from "./httpStatusPolicy.js";
import { getCrawlUrlIdentity } from "./UrlPolicy.js";

export type TerminalOutcome = "success" | "failure" | "skip";

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

export interface TerminalCounterEffects {
	dataKb?: number;
	mediaFiles?: number;
	discoveredLinks?: number;
}

function requireCounterIncrement(count: number, label: string): number {
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new Error(`${label} counter increment must be a non-negative safe integer`);
	}
	return count;
}

export function deriveTerminalCounters(
	current: CrawlCounters,
	outcome: TerminalOutcome,
	effects: TerminalCounterEffects = {},
): CrawlCounters {
	const counters = { ...current };
	const dataKb = effects.dataKb ?? 0;
	kilobytesToBytes(dataKb);
	const mediaFiles = requireCounterIncrement(effects.mediaFiles ?? 0, "media file");
	const discoveredLinks = requireCounterIncrement(effects.discoveredLinks ?? 0, "discovered link");
	counters.pagesScanned += 1;
	counters.linksFound += discoveredLinks;
	counters.mediaFiles += mediaFiles;
	switch (outcome) {
		case "success":
			counters.successCount += 1;
			counters.totalDataKb += dataKb;
			break;
		case "failure":
			counters.failureCount += 1;
			break;
		case "skip":
			counters.skippedCount += 1;
			break;
	}
	return counters;
}

export class CrawlState {
	private readonly terminalOutcomes = new Map<string, TerminalOutcome>();
	private readonly admittedUrls = new Set<string>();
	private readonly domainDelays = new Map<string, number>();
	private readonly domainNextAllowedAt = new Map<string, number>();
	private readonly domainPageCounts = new Map<string, number>();
	private readonly domainAdmissionCounts = new Map<string, number>();
	private readonly redirectReservations = new Map<string, string>();
	private readonly redirectReservationCounts = new Map<string, number>();
	private consecutiveFailures = 0;
	private stopRequested = false;
	private admissionCount: number;

	readonly counters: CrawlCounters;
	stopReason: string | null = null;

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
		this.counters = initialCounters ?? createEmptyCrawlCounters();
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

	canScheduleMore(): boolean {
		return !this.stopRequested && this.hasPageCapacity();
	}

	hasPageCapacity(): boolean {
		return this.counters.pagesScanned < this.options.maxPages;
	}

	remainingAdmissionCapacity(): number {
		return Math.max(0, this.options.maxPages - this.admissionCount);
	}

	hasVisited(url: string): boolean {
		return this.terminalOutcomes.has(url);
	}

	restoreTerminals(records: RestoredTerminalRecord[]): void {
		const restoredUrls = new Set<string>();
		const restoredDomains = new Map<string, string>();
		for (const record of records) {
			if (this.terminalOutcomes.has(record.url) || restoredUrls.has(record.url)) {
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
			this.terminalOutcomes.set(record.url, record.outcome);
			if (record.outcome === "failure") {
				this.consecutiveFailures += 1;
				if (this.consecutiveFailures >= FAILURE_CIRCUIT_BREAKER_THRESHOLD) {
					this.requestStop(
						`Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures`,
					);
				}
			} else {
				this.consecutiveFailures = 0;
			}

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
			if (this.admittedUrls.has(record.url) || restoredUrls.has(record.url)) {
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

		for (const url of restoredUrls) this.admittedUrls.add(url);
		if (consumeGlobalBudget) this.admissionCount += restoredUrls.size;
		for (const [domain, count] of restoredDomainCounts) {
			this.domainAdmissionCounts.set(domain, (this.domainAdmissionCounts.get(domain) ?? 0) + count);
		}
	}

	canAdmit(url: string, domain: string): boolean {
		if (this.admittedUrls.has(url) || this.admissionCount >= this.options.maxPages) {
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
		this.admittedUrls.add(url);
		this.admissionCount += 1;
		this.restoreDomainAdmission(domain);
	}

	tryReserveRedirectDomain(url: string, domain: string, sourceDomain: string): boolean {
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

	releaseRedirectReservation(url: string): void {
		const domain = this.redirectReservations.get(url);
		if (!domain) return;
		this.redirectReservations.delete(url);
		this.decrementRedirectReservation(domain);
	}

	settleDomainAdmission(url: string, fromDomain: string, chargedDomain: string): void {
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
		this.stopReason = options.overrideReason || this.stopReason === null ? reason : this.stopReason;
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

	recordDomainPage(domain: string): void {
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

	releaseDomainAdmission(domain: string): void {
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

	previewTerminalCounters(
		url: string,
		outcome: TerminalOutcome,
		effects: TerminalCounterEffects = {},
	): CrawlCounters {
		if (this.terminalOutcomes.has(url)) {
			throw new Error(`Cannot complete already-terminal URL: ${url}`);
		}

		return deriveTerminalCounters(this.counters, outcome, effects);
	}

	recordTerminal(
		url: string,
		outcome: TerminalOutcome,
		options: TerminalCounterEffects = {},
	): void {
		const nextCounters = this.previewTerminalCounters(url, outcome, options);
		this.terminalOutcomes.set(url, outcome);
		Object.assign(this.counters, nextCounters);

		switch (outcome) {
			case "success":
				this.consecutiveFailures = 0;
				break;
			case "failure":
				this.consecutiveFailures += 1;
				if (this.consecutiveFailures >= FAILURE_CIRCUIT_BREAKER_THRESHOLD) {
					this.requestStop(
						`Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures`,
					);
				}
				break;
			case "skip":
				this.consecutiveFailures = 0;
				break;
		}
	}

	snapshotCounters(): CrawlCounters {
		return { ...this.counters };
	}

	buildProgress(queue: QueueSnapshot, counters?: CrawlCounters) {
		const snapshot = counters ?? this.counters;
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
