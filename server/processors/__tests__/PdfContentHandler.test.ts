import { describe, expect, mock, test } from "bun:test";
import { PAGE_TEXT_LIMITS } from "../../../shared/contracts/index.js";
import { silentLogger } from "../../__tests__/runtimeFixture.js";
import { PDF_CONSTANTS } from "../../constants.js";
import type { ProcessedContent } from "../../types.js";
import { type PdfJsLoader, processPdfContent } from "../PdfContentHandler.js";

function createResult(): ProcessedContent {
	return {
		extractedData: {},
		metadata: {},
		analysis: {},
		mediaCount: 0,
		links: [],
		errors: [],
	};
}

function loaderFor(
	document: object,
	destroyLoading: () => Promise<void> | void = mock(async () => undefined),
): PdfJsLoader {
	return async () =>
		({
			getDocument: () => ({
				promise: Promise.resolve(document),
				destroy: destroyLoading,
			}),
		}) as never;
}

function processWithLoader(
	content: Buffer,
	result: ProcessedContent,
	loadPdfJs: PdfJsLoader,
	signal?: AbortSignal,
) {
	return processPdfContent(content, result, silentLogger, signal, loadPdfJs);
}

function textStream(
	items: Array<{ str: string }>,
): ReadableStream<{ items: Array<{ str: string }> }> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue({ items });
			controller.close();
		},
	});
}

describe("PDF resource lifecycle", () => {
	test("destroys the loading task when the page-count policy rejects its document", async () => {
		const destroy = mock(async () => undefined);
		const result = createResult();
		const loadPdfJs = loaderFor({ numPages: 1001 }, destroy);

		await processWithLoader(Buffer.from("%PDF-oversized"), result, loadPdfJs);

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(result.errors[0]?.type).toBe("pdf_processing_error");
	});

	test("cleans the current page and document when text extraction fails", async () => {
		const cleanup = mock(() => undefined);
		const destroy = mock(async () => undefined);
		const result = createResult();
		const loadPdfJs = loaderFor(
			{
				numPages: 1,
				getPage: async () => ({
					streamTextContent: () =>
						new ReadableStream({
							start(controller) {
								controller.error(new Error("malformed page stream"));
							},
						}),
					cleanup,
				}),
				getMetadata: async () => null,
			},
			destroy,
		);

		await processWithLoader(Buffer.from("%PDF-broken-page"), result, loadPdfJs);

		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(result.errors[0]?.message).toContain("malformed page stream");
	});

	test("cancels decompressed text at the owner budget before reading another chunk", async () => {
		let cancelled = false;
		let reads = 0;
		const result = createResult();
		const loadPdfJs = loaderFor({
			numPages: 1,
			getPage: async () => ({
				streamTextContent: () =>
					new ReadableStream(
						{
							pull(controller) {
								reads += 1;
								controller.enqueue({
									items: [{ str: "a".repeat(PDF_CONSTANTS.MAX_EXTRACTED_TEXT_BYTES + 1) }],
								});
							},
							cancel() {
								cancelled = true;
							},
						},
						{ highWaterMark: 0 },
					),
				cleanup: () => undefined,
			}),
			getMetadata: async () => null,
		});

		await processWithLoader(Buffer.from("%PDF-expanding-text"), result, loadPdfJs);

		expect(result.errors[0]?.message).toContain("PDF extracted text exceeds");
		expect(cancelled).toBe(true);
		expect(reads).toBe(1);
	});

	test("fails boundedly before joining decompressed text beyond the owner budget", async () => {
		const cleanup = mock(() => undefined);
		const destroy = mock(async () => undefined);
		const getMetadata = mock(async () => null);
		const result = createResult();
		const loadPdfJs = loaderFor(
			{
				numPages: 1,
				getPage: async () => ({
					streamTextContent: () =>
						textStream([
							{ str: "a".repeat(PDF_CONSTANTS.MAX_EXTRACTED_TEXT_BYTES / 2) },
							{ str: "b".repeat(PDF_CONSTANTS.MAX_EXTRACTED_TEXT_BYTES / 2 + 1) },
						]),
					cleanup,
				}),
				getMetadata,
			},
			destroy,
		);

		await processWithLoader(Buffer.from("%PDF-expanding-text"), result, loadPdfJs);

		expect(result.errors[0]?.message).toContain("PDF extracted text exceeds");
		expect(getMetadata).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(destroy).toHaveBeenCalledTimes(1);
	});

	test("bounds PDF metadata at the shared page projection", async () => {
		const result = createResult();
		const loadPdfJs = loaderFor({
			numPages: 0,
			getMetadata: async () => ({
				info: { Title: `  ${"🎵".repeat(PAGE_TEXT_LIMITS.metadataValueBytes)}  ` },
			}),
		});

		await processWithLoader(Buffer.from("%PDF-metadata"), result, loadPdfJs);

		expect(new TextEncoder().encode(result.metadata.title ?? "").byteLength).toBeLessThanOrEqual(
			PAGE_TEXT_LIMITS.metadataValueBytes,
		);
		expect(result.metadata.title?.startsWith("🎵")).toBe(true);
	});

	test("propagates caller abort only after owned PDF resources begin cleanup", async () => {
		let rejectText: ((reason: Error) => void) | undefined;
		const cleanup = mock(() => undefined);
		const destroy = mock(async () => {
			rejectText?.(new Error("loading task destroyed"));
		});
		const controller = new AbortController();
		let textController: ReadableStreamDefaultController<unknown> | undefined;
		const loadPdfJs = loaderFor(
			{
				numPages: 1,
				getPage: async () => ({
					streamTextContent: () =>
						new ReadableStream({
							start(controller) {
								textController = controller;
								rejectText = (reason) => controller.error(reason);
							},
						}),
					cleanup,
				}),
				getMetadata: async () => null,
			},
			destroy,
		);
		const processing = processWithLoader(
			Buffer.from("%PDF-abort"),
			createResult(),
			loadPdfJs,
			controller.signal,
		);
		while (!rejectText || !textController) await Promise.resolve();

		controller.abort(new Error("crawl item stopped"));

		await expect(processing).rejects.toThrow("crawl item stopped");
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});
