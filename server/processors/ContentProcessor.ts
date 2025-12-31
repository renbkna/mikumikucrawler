import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import type { Logger } from "../config/logging.js";
import type { ProcessedContent } from "../types.js";
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

interface ExtractedData {
	mainContent?: string;
	jsonLd?: unknown[];
	microdata?: Record<string, unknown>;
	openGraph?: Record<string, string>;
	twitterCards?: Record<string, string>;
	schema?: Record<string, unknown>;
}

interface ContentAnalysis {
	wordCount?: number;
	readingTime?: number;
	language?: string;
	keywords?: Array<{ word: string; count: number }>;
	sentiment?: string;
	readabilityScore?: number;
	quality?: {
		score: number;
		factors: Record<string, number | boolean>;
		issues: string[];
	};
}

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

	constructor(logger: Logger) {
		this.logger = logger;
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
				this.processHtml(content, url, result);
			} else if (contentType.includes("application/json")) {
				this.processJson(content, result);
			} else if (contentType.includes("application/pdf")) {
				// PDF processing requires pdf-parse library which is not installed
				result.errors.push({
					type: "unsupported_content",
					message: "PDF processing not available. Install pdf-parse to enable.",
					timestamp: new Date().toISOString(),
				});
				result.extractedData = { mainContent: "" };
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
	private processHtml(
		content: string | Buffer,
		url: string,
		result: ProcessedContent,
	): void {
		const htmlContent = typeof content === "string" ? content : String(content);
		const $: CheerioAPI = cheerio.load(htmlContent);

		if (typeof $ !== "function") {
			throw new TypeError("Cheerio failed to load content");
		}

		// Extract structured data (JSON-LD, microdata, OpenGraph, etc.)
		const structuredData = safeExtract(
			() => extractStructuredData($),
			{
				jsonLd: [],
				microdata: {},
				openGraph: {},
				twitterCards: {},
				schema: {},
			},
			this.logger,
			"extract structured data",
		);

		// Extract main text content
		const mainContent = safeExtract(
			() => extractMainContent($),
			"",
			this.logger,
			"extract main content",
		);

		result.extractedData = {
			...structuredData,
			mainContent,
		} as ExtractedData;

		// Analyze content (word count, language, keywords, sentiment)
		result.analysis = analyzeContent(mainContent);

		// Extract media (images, videos, audio)
		result.media = safeExtract(
			() => extractMediaInfo($, url),
			[],
			this.logger,
			"extract media info",
		);

		// Extract and classify links
		result.links = safeExtract(
			() => processLinks($, url),
			[],
			this.logger,
			"process links",
		);

		// Extract metadata (title, description, etc.)
		result.metadata = safeExtract(
			() => extractMetadata($) as unknown as Record<string, string>,
			{},
			this.logger,
			"extract metadata",
		);

		// Assess content quality
		(result.analysis as ContentAnalysis).quality = safeExtract(
			() => assessContentQuality($, mainContent),
			{ score: 0, factors: {}, issues: ["Quality assessment failed"] },
			this.logger,
			"assess content quality",
		);
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
