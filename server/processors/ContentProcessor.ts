import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import type { Logger } from "../config/logging.js";
import { PDF_CONSTANTS } from "../constants.js";
import type {
	ContentAnalysis,
	ExtractedData,
	ProcessedContent,
} from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";
import { withTimeout } from "../utils/timeout.js";
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
 * Lazy-loaded PDF.js module to avoid startup overhead.
 */
async function getPDFJS() {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	return pdfjs;
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
				await this.processHtml(content, url, result);
			} else if (contentType.includes("application/json")) {
				this.processJson(content, result);
			} else if (contentType.includes("application/pdf")) {
				await this.processPdf(content, result);
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

	/** Processes PDF content and populates the result object. */
	private async processPdf(
		content: string | Buffer,
		result: ProcessedContent,
	): Promise<void> {
		try {
			// Check file size before processing
			const contentSizeMB =
				(typeof content === "string"
					? Buffer.byteLength(content)
					: content.length) /
				(1024 * 1024);
			if (contentSizeMB > PDF_CONSTANTS.MAX_FILE_SIZE_MB) {
				throw new Error(
					`PDF file too large (${contentSizeMB.toFixed(1)}MB). Maximum allowed: ${PDF_CONSTANTS.MAX_FILE_SIZE_MB}MB`,
				);
			}

			// Convert content to Uint8Array for PDF.js
			const pdfBuffer =
				typeof content === "string" ? Buffer.from(content) : content;
			const data = new Uint8Array(pdfBuffer);

			// Load PDF document with timeout
			const pdfjs = await getPDFJS();
			const pdfDocument = await withTimeout(
				pdfjs.getDocument({ data }).promise,
				PDF_CONSTANTS.PROCESSING_TIMEOUT_MS,
				"PDF loading",
			);

			// Check page count limit
			if (pdfDocument.numPages > PDF_CONSTANTS.MAX_PAGES) {
				throw new Error(
					`PDF has too many pages (${pdfDocument.numPages}). Maximum allowed: ${PDF_CONSTANTS.MAX_PAGES}`,
				);
			}

			// Extract text from all pages
			const textParts: string[] = [];
			for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
				try {
					const page = await pdfDocument.getPage(pageNum);
					const textContent = await page.getTextContent();
					const pageText = (textContent.items as Array<{ str?: string }>)
						.filter(
							(item): item is { str: string } => typeof item.str === "string",
						)
						.map((item) => item.str)
						.join(" ");
					textParts.push(pageText);
					await page.cleanup();
				} catch {
					this.logger.warn(`Failed to extract text from PDF page ${pageNum}`);
				}
			}

			const mainContent = textParts.join("\n\n");

			// Extract metadata
			let metadata: {
				title?: string;
				author?: string;
				subject?: string;
				creationDate?: string;
				modDate?: string;
			} = {};

			try {
				const metadataResult = await pdfDocument.getMetadata();
				if (metadataResult?.info && typeof metadataResult.info === "object") {
					const info = metadataResult.info as Record<
						string,
						string | undefined
					>;
					metadata = {
						title: info.Title,
						author: info.Author,
						subject: info.Subject,
						creationDate: info.CreationDate,
						modDate: info.ModDate,
					};
				}
			} catch {
				this.logger.debug("Could not extract PDF metadata");
			}

			// Analyze the extracted text
			result.analysis = analyzeContent(mainContent);

			result.extractedData = { mainContent };
			result.metadata = {
				title: metadata.title || "",
				author: metadata.author || "",
				description: metadata.subject || "",
				publishDate: metadata.creationDate || "",
				modifiedDate: metadata.modDate || "",
			};

			// PDFs don't have traditional "quality" metrics like HTML
			// but we can assess based on content presence
			const wordCount = result.analysis.wordCount || 0;
			result.analysis.quality = {
				score: wordCount > 100 ? 70 : wordCount > 50 ? 50 : 30,
				factors: {
					hasTitle: !!metadata.title,
					hasAuthor: !!metadata.author,
					contentLength: wordCount,
					pageCount: pdfDocument.numPages,
				},
				issues:
					wordCount < 50
						? ["PDF content appears to be minimal or image-based"]
						: [],
			};

			await pdfDocument.destroy();
		} catch (err) {
			this.logger.error(`PDF processing failed: ${getErrorMessage(err)}`);
			result.errors.push({
				type: "pdf_processing_error",
				message: getErrorMessage(err),
				timestamp: new Date().toISOString(),
			});
			result.extractedData = { mainContent: "" };
		}
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
