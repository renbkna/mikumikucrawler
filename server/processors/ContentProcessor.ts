import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import type { Logger } from "winston";
import type { ProcessedContent } from "../types.js";
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

interface PDFResult {
	type: string;
	text: string;
	pages: number;
	error: string;
	isEmpty: boolean;
}

export class ContentProcessor {
	private readonly logger: Logger;

	constructor(logger: Logger) {
		this.logger = logger;
	}

	/**
	 * Main processing function - extracts all meaningful data from content
	 */
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
				// Ensure content is a string
				const htmlContent =
					typeof content === "string" ? content : String(content);

				// Debug logging
				this.logger.debug(
					`Processing HTML content for ${url}, length: ${
						htmlContent.length
					}, type: ${typeof htmlContent}`,
				);

				// Load content with Cheerio
				const cheerioInstance: CheerioAPI = cheerio.load(htmlContent);

				// Validate that cheerio instance is properly loaded
				if (typeof cheerioInstance !== "function") {
					throw new TypeError("Cheerio failed to load content");
				}

				this.logger.debug(
					`Cheerio loaded successfully for ${url}, type: ${typeof cheerioInstance}`,
				);

				// Extract structured data
				try {
					this.logger.debug(`Calling extractStructuredData for ${url}`);
					result.extractedData = extractStructuredData(cheerioInstance);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					this.logger.warn(`Failed to extract structured data: ${message}`);
					result.extractedData = {};
				}

				// Extract and clean main content
				try {
					(result.extractedData as ExtractedData).mainContent =
						extractMainContent(cheerioInstance);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					this.logger.warn(`Failed to extract main content: ${message}`);
					(result.extractedData as ExtractedData).mainContent = "";
				}

				// Analyze content
				result.analysis = analyzeContent(
					(result.extractedData as ExtractedData).mainContent || "",
				);

				// Process media
				try {
					result.media = extractMediaInfo(cheerioInstance, url);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					this.logger.warn(`Failed to extract media info: ${message}`);
					result.media = [];
				}

				// Process links
				try {
					result.links = processLinks(cheerioInstance, url);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					this.logger.warn(`Failed to process links: ${message}`);
					result.links = [];
				}

				// Extract metadata
				try {
					result.metadata = extractMetadata(
						cheerioInstance,
					) as unknown as Record<string, string>;
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					this.logger.warn(`Failed to extract metadata: ${message}`);
					result.metadata = {};
				}

				// Content quality assessment
				try {
					(result.analysis as ContentAnalysis).quality = assessContentQuality(
						cheerioInstance,
						(result.extractedData as ExtractedData).mainContent || "",
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					this.logger.warn(`Failed to assess content quality: ${message}`);
					(result.analysis as ContentAnalysis).quality = {
						score: 0,
						factors: {},
						issues: ["Quality assessment failed"],
					};
				}
			} else if (contentType.includes("application/pdf")) {
				// PDF processing would go here
				const pdfResult = await this.processPDF();
				result.extractedData = { mainContent: pdfResult.text || "" };
			} else if (contentType.includes("application/json")) {
				// JSON processing
				const jsonResult = processJSON(
					typeof content === "string" ? content : content.toString(),
				);
				result.extractedData = {
					mainContent: JSON.stringify(jsonResult.data || jsonResult.raw || ""),
				};
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			this.logger.error(`Content processing error for ${url}: ${errorMessage}`);
			result.errors.push({
				type: "processing_error",
				message: errorMessage,
				timestamp: new Date().toISOString(),
			});

			// Provide fallback data to prevent crashes
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

		return result;
	}

	async processPDF(): Promise<PDFResult> {
		// PDF processing requires the pdf-parse library which is not included
		// Log a warning and return a structured response indicating this
		this.logger.warn(
			"PDF processing requested but not implemented. Consider adding pdf-parse dependency.",
		);

		return {
			type: "pdf",
			text: "",
			pages: 0,
			error:
				"PDF text extraction is not available. Install pdf-parse to enable this feature.",
			isEmpty: true,
		};
	}
}
