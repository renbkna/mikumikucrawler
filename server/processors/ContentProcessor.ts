import { setTimeout as sleep } from "node:timers/promises";
import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import type { Logger } from "../config/logging.js";
import { TIMEOUT_CONSTANTS } from "../constants.js";
import type { ContentProcessingResult, ProcessedContent } from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";
import { runWithTimeout } from "../utils/timeout.js";
import { analyzeContent } from "./analysisUtils.js";
import { isHtmlLikeContentType, isJsonContentType, isPdfContentType } from "./contentTypes.js";
import {
	extractMainContent,
	extractMediaCount,
	extractMetadata,
	processLinks,
} from "./extractionUtils.js";
import { processPdfContent } from "./PdfContentHandler.js";

/**
 * Safely executes an extraction function and returns a fallback on error.
 * Reduces repetitive try-catch blocks in content processing.
 */
function safeExtract<T>(fn: () => T, fallback: T, logger: Logger, context: string): T {
	try {
		return fn();
	} catch (err) {
		logger.warn(`Failed to ${context}: ${getErrorMessage(err)}`);
		return fallback;
	}
}

async function processingCheckpoint(signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	await sleep(0, undefined, signal ? { signal } : undefined);
	signal?.throwIfAborted();
}

export async function processContent(
	content: string | Buffer,
	url: string,
	contentType: string,
	logger: Logger,
	signal?: AbortSignal,
): Promise<ContentProcessingResult> {
	try {
		signal?.throwIfAborted();
		let processed: ProcessedContent | null = null;
		if (isHtmlLikeContentType(contentType)) {
			processed = await runWithTimeout({
				timeoutMs: TIMEOUT_CONSTANTS.CONTENT_PROCESSING,
				operationName: `HTML processing for ${url}`,
				...(signal ? { signal } : {}),
				run: (operationSignal) => processHtml(content, url, logger, operationSignal),
			});
		} else if (isJsonContentType(contentType)) {
			processed = processJson(content);
		} else if (isPdfContentType(contentType)) {
			processed = await processPdfContent(content, logger, signal);
		}
		signal?.throwIfAborted();
		if (!processed) throw new Error(`Unsupported content type for processing: ${contentType}`);
		return { type: "processed", content: processed };
	} catch (error) {
		signal?.throwIfAborted();
		const message = getErrorMessage(error);
		logger.error(`Content processing error for ${url}: ${message}`);
		return { type: "failed", message };
	}
}

async function processHtml(
	content: string | Buffer,
	url: string,
	logger: Logger,
	signal?: AbortSignal,
): Promise<ProcessedContent> {
	signal?.throwIfAborted();
	const $: CheerioAPI = cheerio.load(typeof content === "string" ? content : String(content));
	await processingCheckpoint(signal);

	// Extract main content first (needed for analysis)
	const mainContent = extractMainContent($);
	await processingCheckpoint(signal);

	// Analysis fields are the resume-visible metrics consumed by the page list.
	const analysis = analyzeContent(mainContent);
	await processingCheckpoint(signal);

	const extraction = {
		mediaCount: safeExtract(() => extractMediaCount($, url, logger), 0, logger, "count media"),
		links: safeExtract(() => processLinks($, url, logger), [], logger, "process links"),
		metadata: safeExtract(() => extractMetadata($), {}, logger, "extract metadata"),
	};
	await processingCheckpoint(signal);

	return { mainContent, analysis, ...extraction };
}

function processJson(content: string | Buffer): ProcessedContent {
	const jsonString = typeof content === "string" ? content : content.toString();
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonString);
	} catch {
		parsed = jsonString.slice(0, 500);
	}
	const mainContent = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
	return {
		mainContent,
		analysis: analyzeContent(mainContent),
		metadata: {},
		mediaCount: 0,
		links: [],
	};
}
