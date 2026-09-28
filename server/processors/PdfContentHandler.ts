import type { PDFDocumentLoadingTask, PDFPageProxy } from "pdfjs-dist";
import { PAGE_TEXT_LIMITS } from "../../shared/contracts/pageData.js";
import { truncateUtf8Text } from "../../shared/text.js";
import type { Logger } from "../config/logging.js";
import { PDF_CONSTANTS } from "../constants.js";
import type { ProcessedContent } from "../types.js";
import { onAbort } from "../utils/abort.js";
import { getErrorMessage } from "../utils/helpers.js";
import { runWithTimeout } from "../utils/timeout.js";
import { analyzeContent } from "./analysisUtils.js";

export type PdfJsLoader = () => Promise<Pick<typeof import("pdfjs-dist"), "getDocument">>;

const getPDFJS: PdfJsLoader = () => import("pdfjs-dist/legacy/build/pdf.mjs");

function cleanPdfMetadata(value: unknown): string {
	return typeof value === "string"
		? truncateUtf8Text(value.trim(), PAGE_TEXT_LIMITS.metadataValueBytes)
		: "";
}

/** Extracts bounded text and metadata from a PDF; rejects when the document violates a limit. */
export async function processPdfContent(
	content: string | Buffer,
	logger: Logger,
	signal?: AbortSignal,
	loadPdfJs: PdfJsLoader = getPDFJS,
): Promise<ProcessedContent> {
	let loadingTask: PDFDocumentLoadingTask | undefined;
	let currentPage: PDFPageProxy | undefined;
	let destroyPromise: Promise<void> | undefined;
	let failure: unknown;
	let processed: ProcessedContent | undefined;
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
			destroyPromise = loadingTask?.destroy() ?? Promise.resolve();
		}
		await destroyPromise;
	};

	try {
		const pdfBuffer = typeof content === "string" ? Buffer.from(content) : content;
		if (pdfBuffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
			throw new Error("Invalid PDF header");
		}
		const data = new Uint8Array(pdfBuffer);
		const pdfjs = await loadPdfJs();
		signal?.throwIfAborted();
		const task = pdfjs.getDocument({ data });
		loadingTask = task;

		await runWithTimeout({
			timeoutMs: PDF_CONSTANTS.PROCESSING_TIMEOUT_MS,
			operationName: "PDF processing",
			...(signal ? { signal } : {}),
			run: async (operationSignal) => {
				using _destroyOnAbort = onAbort(operationSignal, () => {
					void destroyOwnedResource().catch(() => undefined);
				});
				const pdfDocument = await task.promise;
				operationSignal.throwIfAborted();
				if (pdfDocument.numPages > PDF_CONSTANTS.MAX_PAGES) {
					throw new Error(
						`PDF has too many pages (${pdfDocument.numPages}). Maximum allowed: ${PDF_CONSTANTS.MAX_PAGES}`,
					);
				}

				const textParts: string[] = [];
				let extractedTextBytes = 0;
				let textItemCount = 0;
				for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
					let pageHasText = false;
					try {
						operationSignal.throwIfAborted();
						currentPage = await pdfDocument.getPage(pageNum);
						const reader = currentPage.streamTextContent().getReader();
						let streamDone = false;
						try {
							while (!streamDone) {
								operationSignal.throwIfAborted();
								const chunk = await reader.read();
								operationSignal.throwIfAborted();
								streamDone = chunk.done;
								if (!chunk.value) continue;
								for (const item of chunk.value.items) {
									textItemCount += 1;
									if (textItemCount > PDF_CONSTANTS.MAX_TEXT_ITEMS) {
										throw new Error(`PDF text exceeds ${PDF_CONSTANTS.MAX_TEXT_ITEMS} item limit`);
									}
									if (!("str" in item) || item.str.length === 0) continue;

									const separator = textParts.length === 0 ? "" : pageHasText ? " " : "\n\n";
									const nextBytes = Buffer.byteLength(separator) + Buffer.byteLength(item.str);
									if (extractedTextBytes + nextBytes > PDF_CONSTANTS.MAX_EXTRACTED_TEXT_BYTES) {
										throw new Error(
											`PDF extracted text exceeds ${PDF_CONSTANTS.MAX_EXTRACTED_TEXT_BYTES} byte limit`,
										);
									}
									if (separator) textParts.push(separator);
									textParts.push(item.str);
									extractedTextBytes += nextBytes;
									pageHasText = true;
								}
							}
						} finally {
							if (!streamDone) await reader.cancel().catch(() => undefined);
							reader.releaseLock();
						}
					} finally {
						cleanupCurrentPage();
					}
				}

				const mainContent = textParts.join("");
				let metadata: { title?: string; description?: string } = {};

				try {
					const metadataResult = await pdfDocument.getMetadata();
					operationSignal.throwIfAborted();
					if (metadataResult?.info && typeof metadataResult.info === "object") {
						const info = metadataResult.info as Record<string, string | undefined>;
						metadata = {
							title: info.Title,
							description: info.Subject,
						};
					}
				} catch (error) {
					operationSignal.throwIfAborted();
					logger.debug(`Could not extract PDF metadata: ${getErrorMessage(error)}`);
				}

				processed = {
					mainContent,
					analysis: analyzeContent(mainContent),
					metadata: {
						title: cleanPdfMetadata(metadata.title),
						description: cleanPdfMetadata(metadata.description),
					},
					mediaCount: 0,
					links: [],
				};
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

	signal?.throwIfAborted();
	if (failure !== undefined) {
		logger.debug(`PDF processing failed: ${getErrorMessage(failure)}`);
		throw failure;
	}
	if (!processed) throw new Error("PDF processing completed without a result");
	return processed;
}
