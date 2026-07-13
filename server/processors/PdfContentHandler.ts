import type { Logger } from "../config/logging.js";
import { PDF_CONSTANTS } from "../constants.js";
import type { ProcessedContent } from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";
import { runWithTimeout } from "../utils/timeout.js";
import { analyzeContent } from "./analysisUtils.js";
import { applyProcessingErrorDefaults } from "./processingDefaults.js";

interface PdfPage {
	getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
	cleanup(): void;
}

interface PdfDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPage>;
	getMetadata(): Promise<{ info?: object } | null>;
	destroy(): Promise<void> | void;
}

interface PdfLoadingTask {
	promise: Promise<PdfDocument>;
	destroy(): Promise<void> | void;
}

export type PdfJsLoader = () => Promise<{
	getDocument(options: { data: Uint8Array }): PdfLoadingTask;
}>;

const getPDFJS: PdfJsLoader = async () => {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	return pdfjs as unknown as Awaited<ReturnType<PdfJsLoader>>;
};

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("PDF processing aborted");
}

export class PdfContentHandler {
	constructor(
		private readonly logger: Logger,
		private readonly loadPdfJs: PdfJsLoader = getPDFJS,
	) {}

	async process(
		content: string | Buffer,
		result: ProcessedContent,
		signal?: AbortSignal,
	): Promise<void> {
		let loadingTask: PdfLoadingTask | undefined;
		let pdfDocument: PdfDocument | undefined;
		let currentPage: PdfPage | undefined;
		let destroyPromise: Promise<void> | undefined;
		let failure: unknown;
		const cleanupCurrentPage = (): void => {
			const page = currentPage;
			currentPage = undefined;
			try {
				page?.cleanup();
			} catch (error) {
				failure ??= error;
			}
		};

		const destroyOwnedResource = async (): Promise<void> => {
			cleanupCurrentPage();
			if (!destroyPromise) {
				const resource = pdfDocument ?? loadingTask;
				destroyPromise = resource ? Promise.resolve(resource.destroy()) : Promise.resolve();
			}
			await destroyPromise;
		};

		try {
			const contentSizeMB =
				(typeof content === "string" ? Buffer.byteLength(content) : content.length) / (1024 * 1024);
			if (contentSizeMB > PDF_CONSTANTS.MAX_FILE_SIZE_MB) {
				throw new Error(
					`PDF file too large (${contentSizeMB.toFixed(1)}MB). Maximum allowed: ${PDF_CONSTANTS.MAX_FILE_SIZE_MB}MB`,
				);
			}

			const pdfBuffer = typeof content === "string" ? Buffer.from(content) : content;
			if (pdfBuffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
				throw new Error("Invalid PDF header");
			}
			const data = new Uint8Array(pdfBuffer);
			const pdfjs = await this.loadPdfJs();
			throwIfAborted(signal);
			loadingTask = pdfjs.getDocument({ data });

			await runWithTimeout({
				timeoutMs: PDF_CONSTANTS.PROCESSING_TIMEOUT_MS,
				operationName: "PDF processing",
				...(signal ? { signal } : {}),
				run: async (operationSignal) => {
					const destroyOnAbort = () => {
						void destroyOwnedResource().catch(() => undefined);
					};
					operationSignal.addEventListener("abort", destroyOnAbort, { once: true });
					try {
						pdfDocument = await loadingTask?.promise;
						throwIfAborted(operationSignal);
						if (!pdfDocument) {
							throw new Error("PDF document failed to load");
						}
						if (pdfDocument.numPages > PDF_CONSTANTS.MAX_PAGES) {
							throw new Error(
								`PDF has too many pages (${pdfDocument.numPages}). Maximum allowed: ${PDF_CONSTANTS.MAX_PAGES}`,
							);
						}

						const textParts: string[] = [];
						for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
							try {
								throwIfAborted(operationSignal);
								currentPage = await pdfDocument.getPage(pageNum);
								const textContent = await currentPage.getTextContent();
								throwIfAborted(operationSignal);
								textParts.push(
									textContent.items
										.filter((item): item is { str: string } => typeof item.str === "string")
										.map((item) => item.str)
										.join(" "),
								);
							} finally {
								cleanupCurrentPage();
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
							throwIfAborted(operationSignal);
							if (metadataResult?.info && typeof metadataResult.info === "object") {
								const info = metadataResult.info as Record<string, string | undefined>;
								metadata = {
									title: info.Title,
									author: info.Author,
									subject: info.Subject,
									creationDate: info.CreationDate,
									modDate: info.ModDate,
								};
							}
						} catch (error) {
							throwIfAborted(operationSignal);
							this.logger.debug(`Could not extract PDF metadata: ${getErrorMessage(error)}`);
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
							issues: wordCount < 50 ? ["PDF content appears to be minimal or image-based"] : [],
						};
					} finally {
						operationSignal.removeEventListener("abort", destroyOnAbort);
					}
				},
			});
		} catch (error) {
			failure = error;
		}

		try {
			await destroyOwnedResource();
		} catch (error) {
			failure ??= error;
		}

		throwIfAborted(signal);
		if (failure !== undefined) {
			this.logger.error(`PDF processing failed: ${getErrorMessage(failure)}`);
			result.errors.push({
				type: "pdf_processing_error",
				message: getErrorMessage(failure),
				timestamp: new Date().toISOString(),
			});
			applyProcessingErrorDefaults(result, "PDF processing failed");
		}
	}
}
