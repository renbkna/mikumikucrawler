import { describe, expect, test } from "bun:test";
import { silentLogger } from "../../__tests__/runtimeFixture.js";
import { processContent } from "../ContentProcessor.js";

/**
 * CONTRACT: ContentProcessor.processContent
 *
 * Input: (content: string | Buffer, url: string, contentType: string)
 * Output: { type: "processed", content } or { type: "failed", message }
 *
 * Dispatch rules:
 *   - text/html/application/xhtml+xml → HTML extraction pipeline (main content, metadata, links, media count, analysis)
 *   - application/json → JSON processing (mainContent from parsed JSON)
 *   - application/pdf → PDF extraction (text extraction, metadata)
 *   - other → failed (callers only process supported document types)
 *
 * Error contract:
 *   - processing errors and PDF parse failures → failed with the cause's message
 *   - caller aborts propagate after owned processing resources settle
 */

const processTestContent = (content: string | Buffer, url: string, contentType: string) =>
	processContent(content, url, contentType, silentLogger);

async function processOk(content: string | Buffer, url: string, contentType: string) {
	const result = await processTestContent(content, url, contentType);
	if (result.type !== "processed") throw new Error(`Expected processed content: ${result.message}`);
	return result.content;
}

async function processFailure(content: string | Buffer, url: string, contentType: string) {
	const result = await processTestContent(content, url, contentType);
	if (result.type !== "failed") throw new Error("Expected content processing to fail");
	return result.message;
}

describe("ContentProcessor dispatch contract", () => {
	test("propagates caller aborts instead of serializing a late processing result", async () => {
		const controller = new AbortController();
		controller.abort(new Error("item deadline"));

		await expect(
			processContent(
				"<html><main>late</main></html>",
				"https://example.com/late",
				"text/html",
				silentLogger,
				controller.signal,
			),
		).rejects.toThrow("item deadline");
	});

	test("HTML → extracts main content and populates analysis", async () => {
		const html = `<html><head><title>Test</title></head>
			<body><main><h1>Hello World</h1><p>Crawler test content here.</p></main></body></html>`;

		const result = await processOk(html, "https://example.com/test", "text/html");

		expect(result.mainContent).toContain("Hello World");
		expect(result.analysis.wordCount).toBeGreaterThan(0);
		expect(Array.isArray(result.links)).toBe(true);
		expect(result.mediaCount).toBe(0);
	});

	test("rejects an over-depth DOM before any sibling extraction runs", async () => {
		const html = `<body>${"<div>".repeat(129)}<a href="/hidden">hidden</a>${"</div>".repeat(129)}</body>`;

		const message = await processFailure(html, "https://example.com/deep", "text/html");

		expect(message).toContain("DOM exceeds depth 128");
	});

	test("XHTML → uses the HTML extraction pipeline", async () => {
		const html = `<html><body><main>XHTML content</main><a href="/next">Next</a></body></html>`;

		const result = await processOk(
			html,
			"https://example.com/page",
			"application/xhtml+xml; charset=utf-8",
		);

		expect(result.mainContent).toBe("XHTML content");
		expect(result.links.map((link) => link.url)).toEqual(["https://example.com/next"]);
		expect(result.analysis.wordCount).toBeGreaterThan(0);
	});

	test("JSON → mainContent contains serialized data", async () => {
		const json = JSON.stringify({ key: "value", nested: { data: 123 } });

		const result = await processOk(json, "https://api.example.com/data", "application/json");

		expect(result.mainContent).toContain("value");
		expect(result.analysis.wordCount).toBeGreaterThan(0);
		expect(result.analysis.language).toBeDefined();
	});

	test("JSON dispatch normalizes media type casing and parameters", async () => {
		const result = await processOk(
			JSON.stringify({ key: "mixed-case" }),
			"https://api.example.com/data",
			"Application/JSON; Charset=UTF-8",
		);

		expect(result.mainContent).toContain("mixed-case");
		expect(result.analysis.wordCount).toBeGreaterThan(0);
	});

	test("JSON primitives preserve parsed values instead of truthy fallback", async () => {
		const [zero, bool, nil] = await Promise.all([
			processOk("0", "https://api.example.com/zero", "application/json"),
			processOk("false", "https://api.example.com/false", "application/json"),
			processOk("null", "https://api.example.com/null", "application/json"),
		]);

		expect(zero.mainContent).toBe("0");
		expect(bool.mainContent).toBe("false");
		expect(nil.mainContent).toBe("null");
	});

	test("JSON string roots and invalid JSON fallback do not gain extra quotes", async () => {
		const [stringRoot, invalid] = await Promise.all([
			processOk('"hello"', "https://api.example.com/string", "application/json"),
			processOk("not-json", "https://api.example.com/invalid", "application/json"),
		]);

		expect(stringRoot.mainContent).toBe("hello");
		expect(invalid.mainContent).toBe("not-json");
	});

	test("PDF with invalid data → failed", async () => {
		const message = await processFailure(
			Buffer.from("fake pdf content"),
			"https://example.com/doc.pdf",
			"Application/PDF; charset=binary",
		);

		expect(message).toBe("Invalid PDF header");
	});

	test("unsupported content type → failed", async () => {
		const message = await processFailure(
			"some binary data",
			"https://example.com/file.bin",
			"application/octet-stream",
		);

		expect(message).toContain("Unsupported content type");
	});

	test("PDF with valid minimal structure → extracts without errors", async () => {
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

		const result = await processOk(minimalPdf, "https://example.com/test.pdf", "application/pdf");

		expect(result.mainContent).toContain("Hello World");
	}, 30_000);
});
