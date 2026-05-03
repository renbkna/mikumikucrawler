import { Value } from "@sinclair/typebox/value";
import { t } from "elysia";
import { isCrawledPage, type CrawledPage } from "../types.js";
import { CrawlCountersSchema } from "./crawl.js";
import { CrawlPagePayloadSchema, QueueStatsSchema } from "./pageData.js";

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

export const CrawlStartedPayloadSchema = t.Object({
	target: t.String(),
	resume: t.Boolean(),
});

export type CrawlStartedPayload = typeof CrawlStartedPayloadSchema.static;

export const CrawlProgressPayloadSchema = t.Object({
	counters: CrawlCountersSchema,
	queue: QueueStatsSchema,
	elapsedSeconds: t.Number({ minimum: 0 }),
	pagesPerSecond: t.Number({ minimum: 0 }),
	stopReason: t.Nullable(t.String()),
});

export type CrawlProgressPayload = typeof CrawlProgressPayloadSchema.static;

export type CrawlPagePayload = CrawledPage;

export const CrawlLogPayloadSchema = t.Object({
	message: t.String(),
});

export type CrawlLogPayload = typeof CrawlLogPayloadSchema.static;

export const CrawlCompletedPayloadSchema = t.Object({
	counters: CrawlCountersSchema,
});

export type CrawlCompletedPayload = typeof CrawlCompletedPayloadSchema.static;

export const CrawlFailedPayloadSchema = t.Object({
	error: t.String(),
	counters: CrawlCountersSchema,
});

export type CrawlFailedPayload = typeof CrawlFailedPayloadSchema.static;

export const CrawlStoppedPayloadSchema = t.Object({
	stopReason: t.String(),
	counters: CrawlCountersSchema,
});

export type CrawlStoppedPayload = typeof CrawlStoppedPayloadSchema.static;

export const CrawlPausedPayloadSchema = t.Object({
	stopReason: t.Nullable(t.String()),
	counters: CrawlCountersSchema,
});

export type CrawlPausedPayload = typeof CrawlPausedPayloadSchema.static;

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

const EventEnvelopeBaseSchema = {
	crawlId: t.String(),
	sequence: t.Number({ minimum: 1, multipleOf: 1 }),
	timestamp: t.String({ format: "date-time" }),
};

export const CrawlEventEnvelopeSchema = t.Union([
	t.Object({
		type: t.Literal("crawl.started"),
		...EventEnvelopeBaseSchema,
		payload: CrawlStartedPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.progress"),
		...EventEnvelopeBaseSchema,
		payload: CrawlProgressPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.page"),
		...EventEnvelopeBaseSchema,
		payload: CrawlPagePayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.log"),
		...EventEnvelopeBaseSchema,
		payload: CrawlLogPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.completed"),
		...EventEnvelopeBaseSchema,
		payload: CrawlCompletedPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.failed"),
		...EventEnvelopeBaseSchema,
		payload: CrawlFailedPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.stopped"),
		...EventEnvelopeBaseSchema,
		payload: CrawlStoppedPayloadSchema,
	}),
	t.Object({
		type: t.Literal("crawl.paused"),
		...EventEnvelopeBaseSchema,
		payload: CrawlPausedPayloadSchema,
	}),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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
			return Value.Check(CrawlStartedPayloadSchema, payload);
		case "crawl.progress":
			return Value.Check(CrawlProgressPayloadSchema, payload);
		case "crawl.page":
			return isCrawlPagePayload(payload);
		case "crawl.log":
			return Value.Check(CrawlLogPayloadSchema, payload);
		case "crawl.completed":
			return Value.Check(CrawlCompletedPayloadSchema, payload);
		case "crawl.failed":
			return Value.Check(CrawlFailedPayloadSchema, payload);
		case "crawl.stopped":
			return Value.Check(CrawlStoppedPayloadSchema, payload);
		case "crawl.paused":
			return Value.Check(CrawlPausedPayloadSchema, payload);
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
