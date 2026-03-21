import type {
	CrawlCompletedPayload,
	CrawlEventEnvelope,
	CrawlFailedPayload,
	CrawlLogPayload,
	CrawlPagePayload,
	CrawlProgressPayload,
	CrawlStartedPayload,
	CrawlStoppedPayload,
} from "../../server/contracts/events.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasNumberProperty(
	value: Record<string, unknown>,
	key: string,
): value is Record<string, number> {
	return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function isCounters(value: unknown): boolean {
	if (!isRecord(value)) return false;

	return (
		hasNumberProperty(value, "pagesScanned") &&
		hasNumberProperty(value, "successCount") &&
		hasNumberProperty(value, "failureCount") &&
		hasNumberProperty(value, "skippedCount") &&
		hasNumberProperty(value, "linksFound") &&
		hasNumberProperty(value, "mediaFiles") &&
		hasNumberProperty(value, "totalDataKb")
	);
}

function isQueue(value: unknown): boolean {
	if (!isRecord(value)) return false;

	return (
		hasNumberProperty(value, "activeRequests") &&
		hasNumberProperty(value, "queueLength") &&
		hasNumberProperty(value, "elapsedTime") &&
		hasNumberProperty(value, "pagesPerSecond")
	);
}

function isStartedPayload(value: unknown): value is CrawlStartedPayload {
	return (
		isRecord(value) &&
		typeof value.target === "string" &&
		typeof value.resume === "boolean"
	);
}

function isProgressPayload(value: unknown): value is CrawlProgressPayload {
	return (
		isRecord(value) &&
		isCounters(value.counters) &&
		isQueue(value.queue) &&
		typeof value.elapsedSeconds === "number" &&
		Number.isFinite(value.elapsedSeconds) &&
		typeof value.pagesPerSecond === "number" &&
		Number.isFinite(value.pagesPerSecond) &&
		(value.stopReason === null || typeof value.stopReason === "string")
	);
}

function isPagePayload(value: unknown): value is CrawlPagePayload {
	return (
		isRecord(value) &&
		(typeof value.id === "number" || value.id === null) &&
		typeof value.url === "string"
	);
}

function isLogPayload(value: unknown): value is CrawlLogPayload {
	return isRecord(value) && typeof value.message === "string";
}

function isCompletedPayload(value: unknown): value is CrawlCompletedPayload {
	return isRecord(value) && isCounters(value.counters);
}

function isFailedPayload(value: unknown): value is CrawlFailedPayload {
	return (
		isRecord(value) &&
		typeof value.error === "string" &&
		isCounters(value.counters)
	);
}

function isStoppedPayload(value: unknown): value is CrawlStoppedPayload {
	return (
		isRecord(value) &&
		typeof value.stopReason === "string" &&
		isCounters(value.counters)
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

	if (!isRecord(parsed)) return null;
	if (typeof parsed.type !== "string") return null;
	if (typeof parsed.crawlId !== "string") return null;
	if (
		typeof parsed.sequence !== "number" ||
		!Number.isInteger(parsed.sequence) ||
		parsed.sequence < 1
	) {
		return null;
	}
	if (typeof parsed.timestamp !== "string") return null;

	switch (parsed.type) {
		case "crawl.started":
			return isStartedPayload(parsed.payload)
				? (parsed as unknown as CrawlEventEnvelope)
				: null;
		case "crawl.progress":
			return isProgressPayload(parsed.payload)
				? (parsed as unknown as CrawlEventEnvelope)
				: null;
		case "crawl.page":
			return isPagePayload(parsed.payload)
				? (parsed as unknown as CrawlEventEnvelope)
				: null;
		case "crawl.log":
			return isLogPayload(parsed.payload)
				? (parsed as unknown as CrawlEventEnvelope)
				: null;
		case "crawl.completed":
			return isCompletedPayload(parsed.payload)
				? (parsed as unknown as CrawlEventEnvelope)
				: null;
		case "crawl.failed":
			return isFailedPayload(parsed.payload)
				? (parsed as unknown as CrawlEventEnvelope)
				: null;
		case "crawl.stopped":
			return isStoppedPayload(parsed.payload)
				? (parsed as unknown as CrawlEventEnvelope)
				: null;
		default:
			return null;
	}
}
