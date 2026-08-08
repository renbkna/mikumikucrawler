import { afterEach, describe, expect, mock, test } from "bun:test";
import { API_PATHS } from "../../../shared/contracts/index.js";
import { backendUrl } from "../client";
import { DURABLE_SEARCH_RESULT_LIMIT, searchStoredPages } from "../search";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("durable page search client", () => {
	test("queries the server FTS projection and maps stored results to page cards", async () => {
		const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({
				crawlId: "crawl-older-than-live-buffer",
				query: "body needle",
				count: 123,
				results: [
					{
						id: 42,
						url: "https://example.com/stored",
						title: "Stored page",
						description: "metadata description",
						domain: "example.com",
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
						details: {},
					},
				],
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [request, init] = fetchMock.mock.calls[0] ?? [];
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		const url = new URL(String(request));
		expect(`${url.origin}${url.pathname}`).toBe(`${backendUrl}${API_PATHS.search}`);
		expect(url.searchParams.get("q")).toBe("body needle");
		expect(url.searchParams.get("crawlId")).toBe("crawl-older-than-live-buffer");
		expect(url.searchParams.get("limit")).toBe(String(DURABLE_SEARCH_RESULT_LIMIT));
	});

	test("rejects malformed successful search payloads before mapping", async () => {
		globalThis.fetch = mock(async () =>
			Response.json({
				crawlId: "crawl-1",
				query: "needle",
				count: 1,
				results: [{ id: 42, title: "missing required fields" }],
			}),
		) as unknown as typeof fetch;

		await expect(searchStoredPages("crawl-1", "needle")).resolves.toEqual({
			ok: false,
			error: "Unexpected search response",
		});
	});

	test("rejects search results outside the requested query identity", async () => {
		globalThis.fetch = mock(async () =>
			Response.json({
				crawlId: "crawl-2",
				query: "needle",
				count: 1,
				results: [
					{
						id: 42,
						url: "https://example.com/stored",
						title: "Stored page",
						description: "Description",
						domain: "example.com",
						snippet: "needle",
					},
				],
			}),
		) as unknown as typeof fetch;

		await expect(searchStoredPages("crawl-1", "needle")).resolves.toEqual({
			ok: false,
			error: "Unexpected search response",
		});
	});
});
