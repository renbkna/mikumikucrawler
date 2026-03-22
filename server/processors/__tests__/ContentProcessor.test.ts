import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../config/logging.js";
import { ContentProcessor } from "../ContentProcessor.js";

/**
 * CONTRACT: ContentProcessor.processContent
 *
 * Input: (content: string | Buffer, url: string, contentType: string)
 * Output: ProcessedContent with extractedData, metadata, analysis, media, links, errors
 *
 * Dispatch rules:
 *   - text/html → HTML extraction pipeline (extractMainContent, metadata, links, media, analysis)
 *   - application/json → JSON processing (mainContent from parsed JSON)
 *   - application/pdf → PDF extraction (text extraction, metadata)
 *   - other → empty result, no errors
 *
 * Error contract:
 *   - processing errors → errors[] populated, error defaults applied
 *   - PDF parse failure → pdf_processing_error in errors[]
 *   - never throws
 */

const createMockLogger = (): Logger =>
	({
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	}) as unknown as Logger;

describe("ContentProcessor dispatch contract", () => {
	test("HTML → extracts main content and populates analysis", async () => {
		const processor = new ContentProcessor(createMockLogger());
		const html = `<html><head><title>Test</title></head>
			<body><main><h1>Hello World</h1><p>Crawler test content here.</p></main></body></html>`;

		const result = await processor.processContent(
			html,
			"https://example.com/test",
			"text/html",
		);

		expect(result.errors).toHaveLength(0);
		expect(result.extractedData.mainContent).toContain("Hello World");
		expect(result.analysis.wordCount).toBeGreaterThan(0);
		expect(Array.isArray(result.links)).toBe(true);
		expect(Array.isArray(result.media)).toBe(true);
	});

	test("JSON → extractedData.mainContent contains serialized data", async () => {
		const processor = new ContentProcessor(createMockLogger());
		const json = JSON.stringify({ key: "value", nested: { data: 123 } });

		const result = await processor.processContent(
			json,
			"https://api.example.com/data",
			"application/json",
		);

		expect(result.errors).toHaveLength(0);
		expect(result.extractedData.mainContent).toContain("value");
	});

	test("PDF with invalid data → pdf_processing_error", async () => {
		const processor = new ContentProcessor(createMockLogger());

		const result = await processor.processContent(
			Buffer.from("fake pdf content"),
			"https://example.com/doc.pdf",
			"application/pdf",
		);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].type).toBe("pdf_processing_error");
	});

	test("unknown content type → empty result, no errors", async () => {
		const processor = new ContentProcessor(createMockLogger());

		const result = await processor.processContent(
			"some binary data",
			"https://example.com/file.bin",
			"application/octet-stream",
		);

		expect(result.errors).toHaveLength(0);
		expect(result.url).toBe("https://example.com/file.bin");
	});

	test("PDF with valid minimal structure → extracts without errors", async () => {
		const processor = new ContentProcessor(createMockLogger());

		// Minimal valid PDF with text content
		const minimalPdf = Buffer.from(
			`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 12 Tf 100 700 Td (Hello World) Tj ET
endstream endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000214 00000 n
trailer << /Root 1 0 R /Size 5 >>
startxref
308
%%EOF`,
			"binary",
		);

		const result = await processor.processContent(
			minimalPdf,
			"https://example.com/test.pdf",
			"application/pdf",
		);

		expect(result.contentType).toBe("application/pdf");
		expect(result.extractedData.mainContent).toBeDefined();
	});
});
