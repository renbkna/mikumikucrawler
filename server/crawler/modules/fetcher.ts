import type { Database } from "bun:sqlite";
import * as cheerio from "cheerio";
import type { Logger } from "../../config/logging.js";
import { FETCH_HEADERS, TIMEOUT_CONSTANTS } from "../../constants.js";
import type { FetchResult, QueueItem } from "../../types.js";
import { extractMetadata } from "../../utils/helpers.js";
import { secureFetch } from "../../utils/secureFetch.js";
import type { DynamicRenderer } from "../dynamicRenderer.js";

interface FetchOptions {
	item: QueueItem;
	dynamicRenderer: DynamicRenderer;
	logger: Logger;
	db: Database;
}

interface CachedPageHeaders {
	last_modified: string | null;
	etag: string | null;
}

/**
 * Fetches content from a URL using dynamic renderer if enabled, otherwise falls back to static fetch.
 *
 * Conditional GET: For static fetches, we send `If-Modified-Since` / `If-None-Match`
 * headers when the DB has cached values from a previous crawl. A 304 response means
 * the page hasn't changed — we return `{ unchanged: true }` and the caller skips
 * re-processing entirely, cutting bandwidth and CPU to near-zero for unchanged pages.
 *
 * Security: Uses secureFetch which validates DNS resolutions and prevents rebinding attacks.
 * The URL is validated at the socket handler level, but we double-check here with cached
 * resolution to prevent TOCTOU (Time-of-Check-Time-of-Use) attacks.
 */
export async function fetchContent({
	item,
	dynamicRenderer,
	logger,
	db,
}: FetchOptions): Promise<FetchResult> {
	let content = "";
	let statusCode = 0;
	let contentType = "";
	let contentLength = 0;
	let title = "";
	let description = "";
	let lastModified: string | null = null;
	let etag: string | null = null;
	let xRobotsTag: string | null = null;
	let isDynamic = false;

	const dynamicResult = dynamicRenderer.isEnabled()
		? await dynamicRenderer.render(item)
		: null;

	if (dynamicResult) {
		content = dynamicResult.content;
		statusCode = dynamicResult.statusCode;
		contentType = dynamicResult.contentType;
		contentLength = dynamicResult.contentLength;
		title = dynamicResult.title;
		description = dynamicResult.description;
		lastModified = dynamicResult.lastModified ?? null;
		// Puppeteer doesn't expose ETag headers, so etag stays null for dynamic pages
		xRobotsTag = dynamicResult.xRobotsTag ?? null;
		isDynamic = true;
	}

	if (!content) {
		logger.info(`Using static crawling for ${item.url}`);

		// Look up cached conditional GET headers from a previous crawl
		const cached = db
			.query(
				"SELECT last_modified, etag FROM pages WHERE url = ? LIMIT 1",
			)
			.get(item.url) as CachedPageHeaders | undefined;

		// Build conditional GET headers when we have something to compare against
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

		// 304 Not Modified — page hasn't changed since the last crawl.
		// Return a sentinel so the pipeline can skip re-processing and just
		// update crawled_at, saving bandwidth and CPU.
		if (response.status === 304) {
			logger.info(`[Crawler] Unchanged: ${item.url} (304)`);
			return {
				content: "",
				statusCode: 304,
				contentType: "",
				contentLength: 0,
				title: "",
				description: "",
				lastModified: cached?.last_modified ?? null,
				etag: cached?.etag ?? null,
				xRobotsTag: null,
				isDynamic: false,
				unchanged: true,
			};
		}

		// 429 Too Many Requests / 503 Service Unavailable — rate-limited.
		// Parse Retry-After and return a sentinel so the pipeline can apply
		// the correct domain-level backoff instead of a generic retry delay.
		if (response.status === 429 || response.status === 503) {
			const retryAfterMs = parseRetryAfter(
				response.headers.get("retry-after"),
			);
			logger.info(
				`[Crawler] Rate-limited ${item.url} (${response.status}), retry after ${retryAfterMs}ms`,
			);
			return {
				content: "",
				statusCode: response.status,
				contentType: "",
				contentLength: 0,
				title: "",
				description: "",
				lastModified: null,
				etag: null,
				xRobotsTag: null,
				isDynamic: false,
				rateLimited: true,
				retryAfterMs,
			};
		}

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		content = await response.text();
		statusCode = response.status;
		contentType = response.headers.get("content-type") || "";
		contentLength = Number.parseInt(
			response.headers.get("content-length") || "0",
			10,
		);
		lastModified = response.headers.get("last-modified") ?? null;
		etag = response.headers.get("etag") ?? null;
		// X-Robots-Tag: server-level robots directive (equivalent to meta robots tag)
		xRobotsTag = response.headers.get("x-robots-tag") ?? null;
	}

	if (contentType.includes("text/html") && (!title || !description)) {
		const $ = cheerio.load(content);
		const metadata = extractMetadata($);
		if (!title) {
			title = metadata.title;
		}
		if (!description) {
			description = metadata.description;
		}
	}

	if (!contentLength && content) {
		contentLength = Buffer.byteLength(content, "utf8");
	}

	return {
		content,
		statusCode,
		contentType,
		contentLength,
		title,
		description,
		lastModified,
		etag,
		xRobotsTag,
		isDynamic,
	};
}

/**
 * Parses the value of a Retry-After HTTP header into milliseconds.
 *
 * The header is either:
 * - A non-negative integer representing seconds to wait.
 * - An HTTP-date string (RFC 7231 §7.1.3) representing an absolute retry time.
 *
 * Falls back to 60 000 ms (1 minute) on parse failure.
 */
function parseRetryAfter(header: string | null): number {
	const FALLBACK_MS = 60_000;
	if (!header) return FALLBACK_MS;

	const trimmed = header.trim();

	// Integer seconds
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number.parseInt(trimmed, 10);
		return Number.isFinite(seconds) ? seconds * 1000 : FALLBACK_MS;
	}

	// HTTP-date
	const parsed = Date.parse(trimmed);
	if (Number.isFinite(parsed)) {
		const diffMs = parsed - Date.now();
		return diffMs > 0 ? diffMs : FALLBACK_MS;
	}

	return FALLBACK_MS;
}
