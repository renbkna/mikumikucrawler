import { describe, expect, test } from "bun:test";
import { CrawlExportService } from "../CrawlExportService.js";

const pages = [
	{
		id: 7,
		url: "https://example.com/a?x=1,2",
		title: 'A "quoted" title',
		description: "=SUM(A1:A2)",
		contentType: "text/html",
		domain: "example.com",
		content: "<main>Body</main>",
		crawledAt: "2026-04-30T10:00:00Z",
	},
];

describe("crawl export service contract", () => {
	test("JSON export preserves pretty stored page rows", () => {
		const service = new CrawlExportService();

		const result = service.exportPages("crawl:unsafe/id", pages, "json");

		expect(result.body).toBe(JSON.stringify(pages, null, 2));
		expect(result.contentType).toBe("application/json; charset=utf-8");
		expect(result.contentDisposition).toBe(
			'attachment; filename="crawl_unsafe_id.json"',
		);
	});

	test("CSV export preserves header order and row mapping", () => {
		const service = new CrawlExportService();

		const result = service.exportPages("crawl-1", pages, "csv");

		expect(result.body.split("\n")[0]).toBe(
			'"id","url","title","description","contentType","domain","crawledAt"',
		);
		expect(result.body.split("\n")[1]).toContain('"7"');
		expect(result.body.split("\n")[1]).toContain(
			'"https://example.com/a?x=1,2"',
		);
		expect(result.body.split("\n")[1]).toContain('"text/html"');
		expect(result.contentType).toBe("text/csv; charset=utf-8");
	});

	test("CSV escapes quotes and commas", () => {
		const service = new CrawlExportService();

		const result = service.exportPages("crawl-1", pages, "csv");

		expect(result.body).toContain('"A ""quoted"" title"');
		expect(result.body).toContain('"https://example.com/a?x=1,2"');
	});

	test("CSV prefixes dangerous cells", () => {
		const service = new CrawlExportService();
		const dangerousRows = ["=x", "+x", "-x", "@x", "|x", "\tx"].map(
			(value, index) => ({
				...pages[0],
				id: index + 1,
				description: value,
			}),
		);

		const result = service.exportPages("crawl-1", dangerousRows, "csv");

		for (const value of ["'=x", "'+x", "'-x", "'@x", "'|x", "'\tx"]) {
			expect(result.body).toContain(`"${value}"`);
		}
	});

	test("filename sanitization replaces unsafe characters", () => {
		const service = new CrawlExportService();

		const result = service.exportPages("crawl:/unsafe id", [], "csv");

		expect(result.filename).toBe("crawl__unsafe_id.csv");
		expect(result.contentDisposition).toBe(
			'attachment; filename="crawl__unsafe_id.csv"',
		);
	});
});
