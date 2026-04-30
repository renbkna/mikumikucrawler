import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import type { Logger } from "../config/logging.js";
import type {
	ContentAnalysis,
	ExtractedData,
	ProcessedContent,
} from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";
import {
	analyzeContent,
	assessContentQuality,
	processJSON,
} from "./analysisUtils.js";
import {
	extractMainContent,
	extractMediaInfo,
	extractMetadata,
	extractStructuredData,
	processLinks,
} from "./extractionUtils.js";
import { PdfContentHandler } from "./PdfContentHandler.js";

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
			if (contentType.includes("text/html")) {
				await this.processHtml(content, url, result);
			} else if (contentType.includes("application/json")) {
				this.processJson(content, result);
			} else if (contentType.includes("application/pdf")) {
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
			this.setErrorDefaults(result);
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
		result.extractedData = {
			mainContent: JSON.stringify(jsonResult.data || jsonResult.raw || ""),
		};
	}

	/** Sets default values for result object when processing fails. */
	private setErrorDefaults(result: ProcessedContent): void {
		result.extractedData = { mainContent: "" };
		result.analysis = {
			wordCount: 0,
			readingTime: 0,
			language: "unknown",
			keywords: [],
			sentiment: "neutral",
			readabilityScore: 0,
			quality: { score: 0, factors: {}, issues: ["Processing failed"] },
		};
		result.metadata = {};
		result.media = [];
		result.links = [];
	}
}
