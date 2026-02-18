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
		result.analysis = await analyzeContent(mainContent);

		// Run all independent synchronous extractions.
		// These don't depend on each other; if any become async in future,
		// wrap them in Promise.all to regain true concurrency.
		const extractionResults = {
			structuredData: safeExtract(
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
			),
			media: safeExtract(
				() => extractMediaInfo($, url),
				[],
				this.logger,
				"extract media info",
			),
			links: safeExtract(
				() => processLinks($, url),
				[],
				this.logger,
				"process links",
			),
			metadata: safeExtract(
				() => extractMetadata($) as unknown as Record<string, string>,
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

	/** Processes PDF content and populates the result object using pdf-parse. */
	private async processPdf(
		content: string | Buffer,
		result: ProcessedContent,
	): Promise<void> {
		try {
			const pdfBuffer =
				typeof content === "string" ? Buffer.from(content) : content;

			// Check file size before processing
			const contentSizeMB = pdfBuffer.length / (1024 * 1024);
			if (contentSizeMB > PDF_CONSTANTS.MAX_FILE_SIZE_MB) {
				throw new Error(
					`PDF file too large (${contentSizeMB.toFixed(1)}MB). Maximum allowed: ${PDF_CONSTANTS.MAX_FILE_SIZE_MB}MB`,
				);
			}

			// Lazy-load pdf-parse to avoid startup overhead.
			// pdf-parse v2 ships both CJS and ESM builds; the callable may sit on
			// `.default` (CJS interop) or be the module export itself depending on
			// the runtime. Cast to any and normalise to a callable.
			// biome-ignore lint/suspicious/noExplicitAny: pdf-parse ESM/CJS interop
			const pdfParseModule = (await import("pdf-parse")) as any;
			const pdfParse: (
				buf: Buffer,
				opts?: { max?: number },
			) => Promise<{ text: string; numpages: number; info: unknown }> =
				typeof pdfParseModule === "function"
					? pdfParseModule
					: (pdfParseModule.default ?? pdfParseModule);

			// Race against a hard timeout to prevent runaway processing
			const parsePromise = pdfParse(pdfBuffer, {
				// Limit pages parsed to prevent memory exhaustion
				max: PDF_CONSTANTS.MAX_PAGES,
			});
			const timeoutPromise = Bun.sleep(
				PDF_CONSTANTS.PROCESSING_TIMEOUT_MS,
			).then(() => {
				throw new Error("PDF processing timeout");
			});
			const pdfData = await Promise.race([parsePromise, timeoutPromise]);

			if (pdfData.numpages > PDF_CONSTANTS.MAX_PAGES) {
				throw new Error(
					`PDF has too many pages (${pdfData.numpages}). Maximum allowed: ${PDF_CONSTANTS.MAX_PAGES}`,
				);
			}

			const mainContent = pdfData.text ?? "";

			// pdf-parse surfaces metadata via pdfData.info
			const info = (pdfData.info ?? {}) as Record<string, string | undefined>;
			const metadata = {
				title: info.Title,
				author: info.Author,
				subject: info.Subject,
				creationDate: info.CreationDate,
				modDate: info.ModDate,
			};

			result.analysis = await analyzeContent(mainContent);

			result.extractedData = { mainContent };
			result.metadata = {
				title: metadata.title ?? "",
				author: metadata.author ?? "",
				description: metadata.subject ?? "",
				publishDate: metadata.creationDate ?? "",
				modifiedDate: metadata.modDate ?? "",
			};

			// PDFs don't have traditional HTML quality signals;
			// use word count as a proxy for content richness.
			const wordCount = result.analysis.wordCount ?? 0;
			result.analysis.quality = {
				score: wordCount > 100 ? 70 : wordCount > 50 ? 50 : 30,
				factors: {
					hasTitle: !!metadata.title,
					hasAuthor: !!metadata.author,
					contentLength: wordCount,
					pageCount: pdfData.numpages,
				},
				issues:
					wordCount < 50
						? ["PDF content appears to be minimal or image-based"]
						: [],
			};
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
