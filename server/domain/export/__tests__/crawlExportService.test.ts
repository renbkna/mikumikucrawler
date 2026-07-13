import { describe, expect, test } from "bun:test";
import { createCrawlExportResponse } from "../CrawlExportService.js";

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
	test("JSON export preserves stored page rows", async () => {
		const result = createCrawlExportResponse("crawl:unsafe/id", pages, "json");

		expect(await result.json()).toEqual(pages);
		expect(result.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(result.headers.get("content-disposition")).toBe(
			'attachment; filename="crawl_unsafe_id.json"',
		);
		expect(result.headers.get("cache-control")).toBe("no-transform");
	});

	test("CSV export preserves header order and row mapping", async () => {
		const result = createCrawlExportResponse("crawl-1", pages, "csv");
		const body = await result.text();

		expect(body.split("\n")[0]).toBe(
			'"id","url","title","description","contentType","domain","crawledAt"',
		);
		expect(body.split("\n")[1]).toContain('"7"');
		expect(body.split("\n")[1]).toContain('"https://example.com/a?x=1,2"');
		expect(body.split("\n")[1]).toContain('"text/html"');
		expect(result.headers.get("content-type")).toBe("text/csv; charset=utf-8");
	});

	test("CSV escapes quotes and commas", async () => {
		const result = createCrawlExportResponse("crawl-1", pages, "csv");
		const body = await result.text();

		expect(body).toContain('"A ""quoted"" title"');
		expect(body).toContain('"https://example.com/a?x=1,2"');
	});

	test("CSV prefixes dangerous cells", async () => {
		const dangerousRows = ["=x", "+x", "-x", "@x", "|x", "\tx"].map((value, index) => ({
			...pages[0],
			id: index + 1,
			description: value,
		}));

		const result = createCrawlExportResponse("crawl-1", dangerousRows, "csv");
		const body = await result.text();

		for (const value of ["'=x", "'+x", "'-x", "'@x", "'|x", "'\tx"]) {
			expect(body).toContain(`"${value}"`);
		}
	});

	test("filename sanitization replaces unsafe characters", () => {
		const result = createCrawlExportResponse("crawl:/unsafe id", [], "csv");

		expect(result.headers.get("content-disposition")).toBe(
			'attachment; filename="crawl__unsafe_id.csv"',
		);
	});

	test("pulls export rows only as the response stream requests them", async () => {
		let yielded = 0;
		function* rows() {
			for (const page of pages) {
				yielded += 1;
				yield page;
			}
		}

		const response = createCrawlExportResponse("crawl-stream", rows(), "json");
		expect(yielded).toBe(0);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected streaming response body");
		await reader.read();
		expect(yielded).toBe(0);
		await reader.read();
		expect(yielded).toBe(1);
		await reader.cancel();
	});
});
