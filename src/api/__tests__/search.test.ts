import { afterEach, describe, expect, mock, test } from "bun:test";
import { API_PATHS } from "../../../shared/contracts/index.js";
import { getBackendUrl } from "../client";
import { DURABLE_SEARCH_RESULT_LIMIT, searchStoredPages } from "../search";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("durable page search client", () => {
	test("queries the server FTS projection and maps stored results to page cards", async () => {
		const fetchMock = mock(async (_input: RequestInfo | URL) =>
			Response.json({
				query: "body needle",
				count: 123,
				results: [
					{
						id: 42,
						crawlId: "crawl-older-than-live-buffer",
						url: "https://example.com/stored",
						title: "Stored page",
						description: "metadata description",
						domain: "example.com",
						crawledAt: "2026-07-13T00:00:00.000Z",
						wordCount: 10,
						qualityScore: 1,
						titleHighlight: "Stored page",
						snippet: "body needle from durable content",
					},
				],
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await searchStoredPages("crawl-older-than-live-buffer", "body needle");

		expect(result).toEqual({
			ok: true,
			data: {
				count: 123,
				pages: [
					{
						id: 42,
						url: "https://example.com/stored",
						title: "Stored page",
						description: "body needle from durable content",
						domain: "example.com",
					},
				],
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [request] = fetchMock.mock.calls[0] ?? [];
		const url = new URL(String(request));
		expect(`${url.origin}${url.pathname}`).toBe(`${getBackendUrl()}${API_PATHS.search}`);
		expect(url.searchParams.get("q")).toBe("body needle");
		expect(url.searchParams.get("crawlId")).toBe("crawl-older-than-live-buffer");
		expect(url.searchParams.get("limit")).toBe(String(DURABLE_SEARCH_RESULT_LIMIT));
	});
});
