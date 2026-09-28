import type { CrawlCounters } from "../../../shared/contracts/index.js";
import { bytesToKilobytes } from "../../../shared/text.js";

/** Completion data and counter policy shared by runtime state and durable transactions. */
export const TERMINAL_OUTCOME_VALUES = ["success", "failure", "skip"] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOME_VALUES)[number];

export interface TerminalCounterEffects {
	dataBytes?: number;
	mediaFiles?: number;
	discoveredLinks?: number;
}

/** Durable facts consumed as one transition by the in-memory crawl state. */
export interface CommittedTerminal {
	counters: CrawlCounters;
	effects: TerminalCounterEffects;
	chargedDomain: string | null;
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
	const dataBytes = requireCounterIncrement(effects.dataBytes ?? 0, "data byte");
	const mediaFiles = requireCounterIncrement(effects.mediaFiles ?? 0, "media file");
	const discoveredLinks = requireCounterIncrement(effects.discoveredLinks ?? 0, "discovered link");
	counters.pagesScanned += 1;
	counters.linksFound += discoveredLinks;
	counters.mediaFiles += mediaFiles;
	switch (outcome) {
		case "success":
			counters.successCount += 1;
			counters.totalDataKb += bytesToKilobytes(dataBytes);
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

export interface CompletedPageData {
	contentType: string;
	contentLength: number;
	title: string;
	description: string;
	content: string | null;
	mainContent: string;
	wordCount: number;
	readingTime: number;
	language: string;
	mediaCount: number;
	discoveredLinkCount: number;
}
