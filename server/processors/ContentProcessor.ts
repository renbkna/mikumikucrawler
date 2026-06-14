import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import type { Logger } from "../config/logging.js";
import type { ContentAnalysis, ExtractedData } from "../../shared/types.js";
import type { ProcessedContent } from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";
import {
	analyzeContent,
	assessContentQuality,
	processJSON,
} from "./analysisUtils.js";
import {
	isHtmlLikeContentType,
	isJsonContentType,
	isPdfContentType,
} from "./contentTypes.js";
import {
	extractMainContent,
	extractMediaInfo,
	extractMetadata,
	extractStructuredData,
	processLinks,
} from "./extractionUtils.js";
import { PdfContentHandler } from "./PdfContentHandler.js";
import { applyProcessingErrorDefaults } from "./processingDefaults.js";

/**
 * Safely executes an extraction function and returns a fallback on error.
 * Reduces repetitive try-catch blocks in content processing.
 */
function safeExtract<T>(
	fn: () => T,
	fallback: T,
	logger: Logger,
	context: string,
): T {
	try {
		return fn();
	} catch (err) {
		logger.warn(`Failed to ${context}: ${getErrorMessage(err)}`);
		return fallback;
	}
}

function serializeJsonMainContent(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

export async function processContent(
	content: string | Buffer,
	url: string,
	contentType: string,
	logger: Logger,
): Promise<ProcessedContent> {
	const result: ProcessedContent = {
		url,
		contentType,
		extractedData: {},
		metadata: {},
		analysis: {},
		media: [],
		links: [],
		errors: [],
	};

	try {
		if (isHtmlLikeContentType(contentType)) {
			await processHtml(content, url, result, logger);
		} else if (isJsonContentType(contentType)) {
			processJson(content, result);
		} else if (isPdfContentType(contentType)) {
			await new PdfContentHandler(logger).process(content, result);
		}
	} catch (error) {
		logger.error(
			`Content processing error for ${url}: ${getErrorMessage(error)}`,
		);
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
): Promise<void> {
	const htmlContent = typeof content === "string" ? content : String(content);
	const $: CheerioAPI = cheerio.load(htmlContent);

	if (typeof $ !== "function") {
		throw new TypeError("Cheerio failed to load content");
	}

	// Extract main content first (needed for analysis)
	const mainContent = safeExtract(
		() => extractMainContent($),
		"",
		logger,
		"extract main content",
	);

	// Analyze content (word count, language, keywords, sentiment)
	result.analysis = analyzeContent(mainContent);

	const extractionResults = {
		structuredData: safeExtract(
			() => extractStructuredData($, logger),
			{
				jsonLd: [],
				microdata: {},
				openGraph: {},
				twitterCards: {},
				schema: {},
			},
			logger,
			"extract structured data",
		),
		media: safeExtract(
			() => extractMediaInfo($, url, logger),
			[],
			logger,
			"extract media info",
		),
		links: safeExtract(
			() => processLinks($, url, logger),
			[],
			logger,
			"process links",
		),
		metadata: safeExtract(
			() => extractMetadata($),
			{},
			logger,
			"extract metadata",
		),
		quality: safeExtract(
			() => assessContentQuality($, mainContent),
			{ score: 0, factors: {}, issues: ["Quality assessment failed"] },
			logger,
			"assess content quality",
		),
	};

	result.extractedData = {
		...extractionResults.structuredData,
		mainContent,
	} as ExtractedData;

	result.media = extractionResults.media;
	result.links = extractionResults.links;
	result.metadata = extractionResults.metadata;
	(result.analysis as ContentAnalysis).quality = extractionResults.quality;
}

function processJson(content: string | Buffer, result: ProcessedContent): void {
	const jsonString = typeof content === "string" ? content : content.toString();
	const jsonResult = processJSON(jsonString);
	const mainContent =
		jsonResult.data !== undefined ? jsonResult.data : (jsonResult.raw ?? "");
	const serializedContent = serializeJsonMainContent(mainContent);
	result.extractedData = {
		mainContent: serializedContent,
	};
	result.analysis = analyzeContent(serializedContent);
}
