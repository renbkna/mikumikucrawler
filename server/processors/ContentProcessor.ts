import { setTimeout as sleep } from "node:timers/promises";
import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import type { Logger } from "../config/logging.js";
import { TIMEOUT_CONSTANTS } from "../constants.js";
import type { ProcessedContent } from "../types.js";
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
import { applyProcessingErrorDefaults } from "./processingDefaults.js";

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
): Promise<ProcessedContent> {
	const result: ProcessedContent = {
		extractedData: {},
		metadata: {},
		analysis: {},
		mediaCount: 0,
		links: [],
		errors: [],
	};

	try {
		signal?.throwIfAborted();
		if (isHtmlLikeContentType(contentType)) {
			await runWithTimeout({
				timeoutMs: TIMEOUT_CONSTANTS.CONTENT_PROCESSING,
				operationName: `HTML processing for ${url}`,
				...(signal ? { signal } : {}),
				run: (operationSignal) => processHtml(content, url, result, logger, operationSignal),
			});
		} else if (isJsonContentType(contentType)) {
			processJson(content, result);
		} else if (isPdfContentType(contentType)) {
			await processPdfContent(content, result, logger, signal);
		}
		signal?.throwIfAborted();
	} catch (error) {
		signal?.throwIfAborted();
		logger.error(`Content processing error for ${url}: ${getErrorMessage(error)}`);
		result.errors.push({
			type: "processing_error",
			message: getErrorMessage(error),
			timestamp: new Date().toISOString(),
		});
		applyProcessingErrorDefaults(result);
	}

	return result;
}

async function processHtml(
	content: string | Buffer,
	url: string,
	result: ProcessedContent,
	logger: Logger,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const htmlContent = typeof content === "string" ? content : String(content);
	const $: CheerioAPI = cheerio.load(htmlContent);
	await processingCheckpoint(signal);

	// Extract main content first (needed for analysis)
	const mainContent = extractMainContent($);
	await processingCheckpoint(signal);

	// Analysis fields are the resume-visible metrics consumed by the page list.
	result.analysis = analyzeContent(mainContent);
	await processingCheckpoint(signal);

	const extractionResults = {
		mediaCount: safeExtract(() => extractMediaCount($, url, logger), 0, logger, "count media"),
		links: safeExtract(() => processLinks($, url, logger), [], logger, "process links"),
		metadata: safeExtract(() => extractMetadata($), {}, logger, "extract metadata"),
	};
	await processingCheckpoint(signal);

	result.extractedData = { mainContent };
	result.mediaCount = extractionResults.mediaCount;
	result.links = extractionResults.links;
	result.metadata = extractionResults.metadata;
}

function processJson(content: string | Buffer, result: ProcessedContent): void {
	const jsonString = typeof content === "string" ? content : content.toString();
	let mainContent: unknown;
	try {
		mainContent = JSON.parse(jsonString);
	} catch {
		mainContent = jsonString.slice(0, 500);
	}
	const serializedContent =
		typeof mainContent === "string" ? mainContent : JSON.stringify(mainContent);
	result.extractedData = {
		mainContent: serializedContent,
	};
	result.analysis = analyzeContent(serializedContent);
}
