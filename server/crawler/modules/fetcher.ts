import type { Database } from "bun:sqlite";
import type { Logger } from "../../config/logging.js";
import { FETCH_HEADERS, TIMEOUT_CONSTANTS } from "../../constants.js";
import { getCachedHeaders } from "../../data/queries.js";
import { CrawlerError, ErrorCode } from "../../errors.js";
import type { FetchResult, QueueItem } from "../../types.js";
import { secureFetch } from "../../utils/secureFetch.js";
import type { DynamicRenderer } from "../dynamicRenderer.js";

interface FetchOptions {
	item: QueueItem;
	dynamicRenderer: DynamicRenderer;
	logger: Logger;
	db: Database;
}

export async function fetchContent({
	item,
	dynamicRenderer,
	logger,
	db,
}: FetchOptions): Promise<FetchResult> {
	// Try dynamic rendering first
	const dynamicResult = dynamicRenderer.isEnabled()
		? await dynamicRenderer.render(item)
		: null;

	if (dynamicResult) {
		let contentLength = dynamicResult.contentLength;
		if (!contentLength && dynamicResult.content) {
			contentLength = Buffer.byteLength(dynamicResult.content, "utf8");
		}

		return {
			type: "success",
			content: dynamicResult.content,
			statusCode: dynamicResult.statusCode,
			contentType: dynamicResult.contentType,
			contentLength,
			title: dynamicResult.title,
			description: dynamicResult.description,
			lastModified: dynamicResult.lastModified ?? null,
			etag: null,
			xRobotsTag: dynamicResult.xRobotsTag ?? null,
			isDynamic: true,
		};
	}

	// Fall back to static crawling
	logger.info(`Using static crawling for ${item.url}`);

	const cached = getCachedHeaders(db, item.url);

	const conditionalHeaders: Record<string, string> = {};
	if (cached?.last_modified) {
		conditionalHeaders["If-Modified-Since"] = cached.last_modified;
	}
	if (cached?.etag) {
		conditionalHeaders["If-None-Match"] = cached.etag;
	}

	const response = await secureFetch({
		url: item.url,
		headers: { ...FETCH_HEADERS, ...conditionalHeaders },
		signal: AbortSignal.timeout(TIMEOUT_CONSTANTS.STATIC_FETCH),
		redirect: "follow",
	});

	if (response.status === 304) {
		logger.info(`[Crawler] Unchanged: ${item.url} (304)`);
		return {
			type: "unchanged",
			statusCode: 304,
			lastModified: cached?.last_modified ?? null,
			etag: cached?.etag ?? null,
		};
	}

	if (response.status === 429 || response.status === 503) {
		const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
		logger.info(
			`[Crawler] Rate-limited ${item.url} (${response.status}), retry after ${retryAfterMs}ms`,
		);
		return {
			type: "rateLimited",
			statusCode: response.status,
			retryAfterMs,
		};
	}

	const finalUrl = response.url !== item.url ? response.url : undefined;

	if (
		response.status === 404 ||
		response.status === 410 ||
		response.status === 501
	) {
		return {
			type: "permanentFailure",
			statusCode: response.status,
			finalUrl,
		};
	}

	if (response.status === 403) {
		return {
			type: "blocked",
			statusCode: response.status,
			finalUrl,
		};
	}

	if (!response.ok) {
		throw new CrawlerError(
			ErrorCode.NETWORK_HTTP,
			`HTTP error! status: ${response.status}`,
		);
	}

	const contentLengthHeader = Number.parseInt(
		response.headers.get("content-length") || "0",
		10,
	);
	if (
		contentLengthHeader > 10 * 1024 * 1024 &&
		!response.headers.get("content-type")?.includes("text/")
	) {
		throw new CrawlerError(
			ErrorCode.NETWORK_TOO_LARGE,
			`Response too large: ${contentLengthHeader} bytes`,
		);
	}

	const content = await response.text();

	return {
		type: "success",
		content,
		statusCode: response.status,
		contentType: response.headers.get("content-type") || "",
		contentLength: Number.parseInt(
			response.headers.get("content-length") || "0",
			10,
		),
		title: "",
		description: "",
		lastModified: response.headers.get("last-modified") ?? null,
		etag: response.headers.get("etag") ?? null,
		xRobotsTag: response.headers.get("x-robots-tag") ?? null,
		isDynamic: false,
		finalUrl,
	};
}

function parseRetryAfter(header: string | null): number {
	const FALLBACK_MS = 60_000;
	if (!header) return FALLBACK_MS;

	const trimmed = header.trim();

	if (/^\d+$/.test(trimmed)) {
		const seconds = Number.parseInt(trimmed, 10);
		return Number.isFinite(seconds) ? seconds * 1000 : FALLBACK_MS;
	}

	const parsed = Date.parse(trimmed);
	if (Number.isFinite(parsed)) {
		const diffMs = parsed - Date.now();
		return diffMs > 0 ? diffMs : FALLBACK_MS;
	}

	return FALLBACK_MS;
}
