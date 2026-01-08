import { URL } from "node:url";
import * as cheerio from "cheerio";
import { FETCH_HEADERS, TIMEOUT_CONSTANTS } from "../../constants.js";
import type { FetchResult, QueueItem } from "../../types.js";
import { extractMetadata } from "../../utils/helpers.js";
import type { DynamicRenderer } from "../dynamicRenderer.js";
import type { Logger } from "../../config/logging.js";

interface FetchOptions {
	item: QueueItem;
	dynamicRenderer: DynamicRenderer;
	logger: Logger;
}

/**
 * Fetches content from a URL using dynamic renderer if enabled, otherwise falls back to static fetch.
 */
export async function fetchContent({
	item,
	dynamicRenderer,
	logger,
}: FetchOptions): Promise<FetchResult> {
	let content = "";
	let statusCode = 0;
	let contentType = "";
	let contentLength = 0;
	let title = "";
	let description = "";
	let lastModified: string | null = null;
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
		isDynamic = true;
	}

	if (!content) {
		logger.info(`Using static crawling for ${item.url}`);
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			TIMEOUT_CONSTANTS.STATIC_FETCH,
		);

		try {
			const response = await fetch(item.url, {
				headers: FETCH_HEADERS,
				signal: controller.signal,
				redirect: "follow",
			});
			clearTimeout(timeoutId);

			// Note: We don't throw on !ok here to allow processing error pages if they have content,
			// but the original logic threw an error. We will preserve original behavior for consistency.
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
		} catch (error) {
			clearTimeout(timeoutId);
			throw error;
		}
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
		isDynamic,
	};
}
