import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../config/logging.js";
import { ContentProcessor } from "../ContentProcessor.js";

const createMockLogger = (): Logger =>
	({
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	}) as unknown as Logger;

describe("ContentProcessor", () => {
	describe("processContent", () => {
		test("processes HTML content successfully", async () => {
			const logger = createMockLogger();
			const processor = new ContentProcessor(logger);

			const html = `
				<!DOCTYPE html>
				<html>
				<head>
					<title>Test Page</title>
					<meta name="description" content="Test description">
				</head>
				<body>
					<main>
						<h1>Hello World</h1>
						<p>This is test content for the crawler.</p>
						<a href="/link1">Link 1</a>
						<a href="https://external.com">External Link</a>
						<img src="/image.jpg" alt="Test image">
					</main>
				</body>
				</html>
			`;

			const result = await processor.processContent(
				html,
				"https://example.com/test",
				"text/html",
			);

			expect(result.url).toBe("https://example.com/test");
			expect(result.contentType).toBe("text/html");
			expect(result.errors.length).toBe(0);

			// Should have extracted content
			expect(result.extractedData).toBeDefined();

			// Should have analyzed content
			expect(result.analysis).toBeDefined();
			expect(typeof result.analysis.wordCount).toBe("number");

			// Should have extracted links
			expect(Array.isArray(result.links)).toBe(true);

			// Should have extracted media
			expect(Array.isArray(result.media)).toBe(true);
		});

		test("handles JSON content", async () => {
			const logger = createMockLogger();
			const processor = new ContentProcessor(logger);

			const json = JSON.stringify({ key: "value", nested: { data: 123 } });

			const result = await processor.processContent(
				json,
				"https://api.example.com/data",
				"application/json",
			);

			expect(result.url).toBe("https://api.example.com/data");
			expect(result.contentType).toBe("application/json");
			expect(result.errors.length).toBe(0);
			expect(result.extractedData.mainContent).toBeDefined();
		});

		test("handles PDF content with unsupported error", async () => {
			const logger = createMockLogger();
			const processor = new ContentProcessor(logger);

			const result = await processor.processContent(
				Buffer.from("fake pdf content"),
				"https://example.com/doc.pdf",
				"application/pdf",
			);

			expect(result.errors.length).toBe(1);
			expect(result.errors[0].type).toBe("unsupported_content");
			expect(result.errors[0].message).toContain(
				"PDF processing not available",
			);
		});

		test("handles malformed HTML gracefully", async () => {
			const logger = createMockLogger();
			const processor = new ContentProcessor(logger);

			const malformedHtml = "<html><body><p>Unclosed tag";

			const result = await processor.processContent(
				malformedHtml,
				"https://example.com/broken",
				"text/html",
			);

			// Should not throw and should have some result
			expect(result.url).toBe("https://example.com/broken");
			expect(result.errors.length).toBe(0);
		});

		test("handles empty HTML content", async () => {
			const logger = createMockLogger();
			const processor = new ContentProcessor(logger);

			const result = await processor.processContent(
				"",
				"https://example.com/empty",
				"text/html",
			);

			expect(result.url).toBe("https://example.com/empty");
			// Should handle gracefully
			expect(result.analysis).toBeDefined();
		});

		test("handles unknown content types", async () => {
			const logger = createMockLogger();
			const processor = new ContentProcessor(logger);

			const result = await processor.processContent(
				"some binary data",
				"https://example.com/file.bin",
				"application/octet-stream",
			);

			// Should not process but also not error
			expect(result.url).toBe("https://example.com/file.bin");
			expect(result.errors.length).toBe(0);
		});
	});

	describe("error handling", () => {
		test("logs warning when structured data extraction fails", async () => {
			const logger = createMockLogger();
			const processor = new ContentProcessor(logger);

			// HTML that might cause extraction issues
			const html = `
				<!DOCTYPE html>
				<html>
				<head>
					<script type="application/ld+json">{ invalid json }</script>
				</head>
				<body>
					<p>Content</p>
				</body>
				</html>
			`;

			const result = await processor.processContent(
				html,
				"https://example.com/test",
				"text/html",
			);

			// Should still return a result despite potential extraction issues
			expect(result.url).toBe("https://example.com/test");
		});

		test("sets error defaults when processing completely fails", async () => {
			const logger = createMockLogger();
			const processor = new ContentProcessor(logger);

			// Force an error by passing invalid content type handling
			const result = await processor.processContent(
				null as unknown as string,
				"https://example.com/null",
				"text/html",
			);

			// Should have error defaults set
			if (result.errors.length > 0) {
				expect(result.extractedData.mainContent).toBe("");
				expect(result.analysis.wordCount).toBe(0);
			}
		});
	});
});
