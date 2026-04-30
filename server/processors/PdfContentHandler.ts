import type { Logger } from "../config/logging.js";
import { PDF_CONSTANTS } from "../constants.js";
import type { ProcessedContent } from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";
import { withTimeout } from "../utils/timeout.js";
import { analyzeContent } from "./analysisUtils.js";

async function getPDFJS() {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	return pdfjs;
}

export class PdfContentHandler {
	constructor(private readonly logger: Logger) {}

	async process(
		content: string | Buffer,
		result: ProcessedContent,
	): Promise<void> {
		try {
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

			const pdfBuffer =
				typeof content === "string" ? Buffer.from(content) : content;
			const data = new Uint8Array(pdfBuffer);
			const pdfjs = await getPDFJS();
			const pdfDocument = await withTimeout(
				pdfjs.getDocument({ data }).promise,
				PDF_CONSTANTS.PROCESSING_TIMEOUT_MS,
				"PDF loading",
			);

			if (pdfDocument.numPages > PDF_CONSTANTS.MAX_PAGES) {
				throw new Error(
					`PDF has too many pages (${pdfDocument.numPages}). Maximum allowed: ${PDF_CONSTANTS.MAX_PAGES}`,
				);
			}

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

			result.analysis = analyzeContent(mainContent);
			result.extractedData = { mainContent };
			result.metadata = {
				title: metadata.title || "",
				author: metadata.author || "",
				description: metadata.subject || "",
				publishDate: metadata.creationDate || "",
				modifiedDate: metadata.modDate || "",
			};

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
}
