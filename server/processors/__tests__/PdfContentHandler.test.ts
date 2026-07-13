import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../config/logging.js";
import type { ProcessedContent } from "../../types.js";
import { PdfContentHandler, type PdfJsLoader } from "../PdfContentHandler.js";

function createLogger(): Logger {
	return {
		info: mock(() => undefined),
		warn: mock(() => undefined),
		error: mock(() => undefined),
		debug: mock(() => undefined),
	} as unknown as Logger;
}

function createResult(): ProcessedContent {
	return {
		extractedData: {},
		metadata: {},
		analysis: {},
		media: [],
		links: [],
		errors: [],
	};
}

function loaderFor(document: object, destroyLoading = mock(async () => undefined)): PdfJsLoader {
	return async () =>
		({
			getDocument: () => ({
				promise: Promise.resolve(document),
				destroy: destroyLoading,
			}),
		}) as never;
}

describe("PDF resource lifecycle", () => {
	test("destroys a loaded document when the page-count policy rejects it", async () => {
		const destroy = mock(async () => undefined);
		const result = createResult();
		const handler = new PdfContentHandler(
			createLogger(),
			loaderFor({
				numPages: 1001,
				destroy,
			}),
		);

		await handler.process(Buffer.from("%PDF-oversized"), result);

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(result.errors[0]?.type).toBe("pdf_processing_error");
	});

	test("cleans the current page and document when text extraction fails", async () => {
		const cleanup = mock(() => undefined);
		const destroy = mock(async () => undefined);
		const result = createResult();
		const handler = new PdfContentHandler(
			createLogger(),
			loaderFor({
				numPages: 1,
				getPage: async () => ({
					getTextContent: async () => {
						throw new Error("malformed page stream");
					},
					cleanup,
				}),
				getMetadata: async () => null,
				destroy,
			}),
		);

		await handler.process(Buffer.from("%PDF-broken-page"), result);

		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(result.errors[0]?.message).toContain("malformed page stream");
	});

	test("propagates caller abort only after owned PDF resources begin cleanup", async () => {
		let rejectText: ((reason: Error) => void) | undefined;
		const cleanup = mock(() => undefined);
		const destroy = mock(async () => {
			rejectText?.(new Error("document destroyed"));
		});
		const controller = new AbortController();
		const handler = new PdfContentHandler(
			createLogger(),
			loaderFor({
				numPages: 1,
				getPage: async () => ({
					getTextContent: () =>
						new Promise<never>((_resolve, reject) => {
							rejectText = reject;
						}),
					cleanup,
				}),
				getMetadata: async () => null,
				destroy,
			}),
		);
		const processing = handler.process(
			Buffer.from("%PDF-abort"),
			createResult(),
			controller.signal,
		);
		while (!rejectText) await Promise.resolve();

		controller.abort(new Error("crawl item stopped"));

		await expect(processing).rejects.toThrow("crawl item stopped");
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});
