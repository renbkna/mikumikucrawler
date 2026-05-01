import type { QueueStats } from "../types.js";
import { isCrawledPage, isQueueStats, type CrawledPage } from "../types.js";
import type { CrawlCounters } from "./crawl.js";
import { isCrawlCounters } from "./crawl.js";

export const CrawlEventTypeValues = [
	"crawl.started",
	"crawl.progress",
	"crawl.page",
	"crawl.log",
	"crawl.completed",
	"crawl.failed",
	"crawl.stopped",
	"crawl.paused",
] as const;

export type CrawlEventType = (typeof CrawlEventTypeValues)[number];

export const LIVE_CRAWL_EVENT_TYPE_VALUES = [
	"crawl.started",
	"crawl.progress",
	"crawl.page",
	"crawl.log",
] as const;

export const TERMINAL_CRAWL_EVENT_TYPE_VALUES = [
	"crawl.completed",
	"crawl.failed",
	"crawl.stopped",
] as const;

export const SETTLED_CRAWL_EVENT_TYPE_VALUES = [
	...TERMINAL_CRAWL_EVENT_TYPE_VALUES,
	"crawl.paused",
] as const;

export type LiveCrawlEventType = (typeof LIVE_CRAWL_EVENT_TYPE_VALUES)[number];
export type TerminalCrawlEventType =
	(typeof TERMINAL_CRAWL_EVENT_TYPE_VALUES)[number];
export type SettledCrawlEventType =
	(typeof SETTLED_CRAWL_EVENT_TYPE_VALUES)[number];

export interface CrawlStartedPayload {
	target: string;
	resume: boolean;
}

export interface CrawlProgressPayload {
	counters: CrawlCounters;
	queue: QueueStats;
	elapsedSeconds: number;
	pagesPerSecond: number;
	stopReason: string | null;
}

export type CrawlPagePayload = CrawledPage;

export interface CrawlLogPayload {
	message: string;
}

export interface CrawlCompletedPayload {
	counters: CrawlCounters;
}

export interface CrawlFailedPayload {
	error: string;
	counters: CrawlCounters;
}

export interface CrawlStoppedPayload {
	stopReason: string;
	counters: CrawlCounters;
}

export interface CrawlPausedPayload {
	stopReason: string | null;
	counters: CrawlCounters;
}

export interface CrawlEventMap {
	"crawl.started": CrawlStartedPayload;
	"crawl.progress": CrawlProgressPayload;
	"crawl.page": CrawlPagePayload;
	"crawl.log": CrawlLogPayload;
	"crawl.completed": CrawlCompletedPayload;
	"crawl.failed": CrawlFailedPayload;
	"crawl.stopped": CrawlStoppedPayload;
	"crawl.paused": CrawlPausedPayload;
}

export interface CrawlEventEnvelopeBase<TType extends CrawlEventType> {
	type: TType;
	crawlId: string;
	sequence: number;
	timestamp: string;
	payload: CrawlEventMap[TType];
}

export type CrawlEventEnvelope = {
	[TType in CrawlEventType]: CrawlEventEnvelopeBase<TType>;
}[CrawlEventType];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isCounters(value: unknown): value is CrawlCounters {
	return isCrawlCounters(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCrawlPagePayload(value: unknown): value is CrawlPagePayload {
	return isCrawledPage(value);
}

function isPayloadForType<TType extends CrawlEventType>(
	type: TType,
	payload: unknown,
): payload is CrawlEventMap[TType] {
	switch (type) {
		case "crawl.started":
			return (
				isRecord(payload) &&
				typeof payload.target === "string" &&
				typeof payload.resume === "boolean"
			);
		case "crawl.progress":
			return (
				isRecord(payload) &&
				isCounters(payload.counters) &&
				isQueueStats(payload.queue) &&
				isNonNegativeFiniteNumber(payload.elapsedSeconds) &&
				isNonNegativeFiniteNumber(payload.pagesPerSecond) &&
				(payload.stopReason === null || typeof payload.stopReason === "string")
			);
		case "crawl.page":
			return isCrawlPagePayload(payload);
		case "crawl.log":
			return isRecord(payload) && typeof payload.message === "string";
		case "crawl.completed":
			return isRecord(payload) && isCounters(payload.counters);
		case "crawl.failed":
			return (
				isRecord(payload) &&
				typeof payload.error === "string" &&
				isCounters(payload.counters)
			);
		case "crawl.stopped":
			return (
				isRecord(payload) &&
				typeof payload.stopReason === "string" &&
				isCounters(payload.counters)
			);
		case "crawl.paused":
			return (
				isRecord(payload) &&
				(payload.stopReason === null ||
					typeof payload.stopReason === "string") &&
				isCounters(payload.counters)
			);
	}
}

export function isCrawlEventType(value: unknown): value is CrawlEventType {
	return (
		typeof value === "string" &&
		CrawlEventTypeValues.includes(value as CrawlEventType)
	);
}

export function isLiveCrawlEventType(
	value: CrawlEventType,
): value is LiveCrawlEventType {
	return LIVE_CRAWL_EVENT_TYPE_VALUES.includes(value as LiveCrawlEventType);
}

export function isTerminalCrawlEventType(
	value: CrawlEventType,
): value is TerminalCrawlEventType {
	return TERMINAL_CRAWL_EVENT_TYPE_VALUES.includes(
		value as TerminalCrawlEventType,
	);
}

export function isSettledCrawlEventType(
	value: CrawlEventType,
): value is SettledCrawlEventType {
	return SETTLED_CRAWL_EVENT_TYPE_VALUES.includes(
		value as SettledCrawlEventType,
	);
}

export function isCrawlEventEnvelope(
	value: unknown,
): value is CrawlEventEnvelope {
	if (!isRecord(value) || !isCrawlEventType(value.type)) {
		return false;
	}

	const sequence = value.sequence;
	return (
		typeof value.crawlId === "string" &&
		Number.isInteger(sequence) &&
		typeof sequence === "number" &&
		sequence >= 1 &&
		typeof value.timestamp === "string" &&
		isPayloadForType(value.type, value.payload)
	);
}

export function parseCrawlEventEnvelope(
	raw: string,
): CrawlEventEnvelope | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	return isCrawlEventEnvelope(parsed) ? parsed : null;
}
