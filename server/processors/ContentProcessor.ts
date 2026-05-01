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

/**
 * Orchestrates the extraction and analysis pipeline for raw page content.
 *
 * This class coordinates multiple utility modules to extract structured data,
 * analyze sentiment, and assess quality in a single pass.
 */
export class ContentProcessor {
	private readonly logger: Logger;
	private readonly pdfHandler: PdfContentHandler;

	constructor(logger: Logger) {
		this.logger = logger;
		this.pdfHandler = new PdfContentHandler(logger);
	}

	/** Extracts metadata, content, links, and media from raw source data. */
	async processContent(
		content: string | Buffer,
		url: string,
		contentType: string,
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
				await this.processHtml(content, url, result);
			} else if (isJsonContentType(contentType)) {
				this.processJson(content, result);
			} else if (isPdfContentType(contentType)) {
				await this.pdfHandler.process(content, result);
			}
		} catch (error) {
			this.logger.error(
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

	/** Processes HTML content and populates the result object. */
	private async processHtml(
		content: string | Buffer,
		url: string,
		result: ProcessedContent,
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
			this.logger,
			"extract main content",
		);

		// Analyze content (word count, language, keywords, sentiment)
		result.analysis = analyzeContent(mainContent);

		// Optimization: Parallelize independent extractions
		// These don't depend on each other, so run them concurrently
		const extractionResults = {
			structuredData: safeExtract(
				() => extractStructuredData($, this.logger),
				{
					jsonLd: [],
					microdata: {},
					openGraph: {},
					twitterCards: {},
					schema: {},
				},
				this.logger,
				"extract structured data",
			),
			media: safeExtract(
				() => extractMediaInfo($, url, this.logger),
				[],
				this.logger,
				"extract media info",
			),
			links: safeExtract(
				() => processLinks($, url, this.logger),
				[],
				this.logger,
				"process links",
			),
			metadata: safeExtract(
				() => extractMetadata($),
				{},
				this.logger,
				"extract metadata",
			),
			quality: safeExtract(
				() => assessContentQuality($, mainContent),
				{ score: 0, factors: {}, issues: ["Quality assessment failed"] },
				this.logger,
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

	/** Processes JSON content and populates the result object. */
	private processJson(
		content: string | Buffer,
		result: ProcessedContent,
	): void {
		const jsonString =
			typeof content === "string" ? content : content.toString();
		const jsonResult = processJSON(jsonString);
		const mainContent =
			jsonResult.data !== undefined ? jsonResult.data : (jsonResult.raw ?? "");
		const serializedContent = serializeJsonMainContent(mainContent);
		result.extractedData = {
			mainContent: serializedContent,
		};
		result.analysis = analyzeContent(serializedContent);
	}
}
