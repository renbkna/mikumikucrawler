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
 *   - text/html/application/xhtml+xml → HTML extraction pipeline (extractMainContent, metadata, links, media, analysis)
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

	test("XHTML → uses the HTML extraction pipeline", async () => {
		const processor = new ContentProcessor(createMockLogger());
		const html = `<html><body><main>XHTML content</main><a href="/next">Next</a></body></html>`;

		const result = await processor.processContent(
			html,
			"https://example.com/page",
			"application/xhtml+xml; charset=utf-8",
		);

		expect(result.errors).toHaveLength(0);
		expect(result.extractedData.mainContent).toBe("XHTML content");
		expect(result.links.map((link) => link.url)).toEqual([
			"https://example.com/next",
		]);
		expect(result.analysis.wordCount).toBeGreaterThan(0);
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
		expect(result.analysis.wordCount).toBeGreaterThan(0);
		expect(result.analysis.language).toBeDefined();
		expect(result.analysis.sentiment).toBeDefined();
	});

	test("JSON dispatch normalizes media type casing and parameters", async () => {
		const processor = new ContentProcessor(createMockLogger());

		const result = await processor.processContent(
			JSON.stringify({ key: "mixed-case" }),
			"https://api.example.com/data",
			"Application/JSON; Charset=UTF-8",
		);

		expect(result.errors).toHaveLength(0);
		expect(result.extractedData.mainContent).toContain("mixed-case");
		expect(result.analysis.wordCount).toBeGreaterThan(0);
	});

	test("JSON primitives preserve parsed values instead of truthy fallback", async () => {
		const processor = new ContentProcessor(createMockLogger());

		const [zero, bool, nil] = await Promise.all([
			processor.processContent(
				"0",
				"https://api.example.com/zero",
				"application/json",
			),
			processor.processContent(
				"false",
				"https://api.example.com/false",
				"application/json",
			),
			processor.processContent(
				"null",
				"https://api.example.com/null",
				"application/json",
			),
		]);

		expect(zero.extractedData.mainContent).toBe("0");
		expect(bool.extractedData.mainContent).toBe("false");
		expect(nil.extractedData.mainContent).toBe("null");
	});

	test("JSON string roots and invalid JSON fallback do not gain extra quotes", async () => {
		const processor = new ContentProcessor(createMockLogger());

		const [stringRoot, invalid] = await Promise.all([
			processor.processContent(
				'"hello"',
				"https://api.example.com/string",
				"application/json",
			),
			processor.processContent(
				"not-json",
				"https://api.example.com/invalid",
				"application/json",
			),
		]);

		expect(stringRoot.extractedData.mainContent).toBe("hello");
		expect(invalid.extractedData.mainContent).toBe("not-json");
	});

	test("PDF with invalid data → pdf_processing_error", async () => {
		const processor = new ContentProcessor(createMockLogger());

		const result = await processor.processContent(
			Buffer.from("fake pdf content"),
			"https://example.com/doc.pdf",
			"Application/PDF; charset=binary",
		);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].type).toBe("pdf_processing_error");
		expect(result.extractedData).toEqual({ mainContent: "" });
		expect(result.metadata).toEqual({});
		expect(result.media).toEqual([]);
		expect(result.links).toEqual([]);
		expect(result.analysis).toMatchObject({
			wordCount: 0,
			readingTime: 0,
			language: "unknown",
			sentiment: "neutral",
			readabilityScore: 0,
			quality: { score: 0, issues: ["PDF processing failed"] },
		});
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
