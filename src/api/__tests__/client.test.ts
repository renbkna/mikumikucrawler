import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildCrawlEventsPath, buildCrawlExportPath } from "../../../shared/contracts/index.js";
import { downloadCrawlExport, getBackendUrl, resolveBackendUrl } from "../client";
import { createCrawl, subscribeToCrawlEvents } from "../crawls";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.EventSource = originalEventSource;
});

describe("API client backend URL resolution", () => {
	test("uses explicit VITE_BACKEND_URL when configured", () => {
		expect(
			resolveBackendUrl(
				{ VITE_BACKEND_URL: "https://api.example.test", DEV: true },
				"http://localhost:5173",
			),
		).toBe("https://api.example.test");
	});

	test("defaults Vite dev builds to the Bun backend port", () => {
		expect(resolveBackendUrl({ DEV: true }, "http://localhost:5173")).toBe("http://localhost:3000");
	});

	test("uses same origin outside Vite dev for backend-served static builds", () => {
		expect(resolveBackendUrl({}, "https://crawler.example.test")).toBe(
			"https://crawler.example.test",
		);
	});

	test("download export uses the resolved backend API URL", async () => {
		const fetchMock = mock(async () => {
			return new Response("{}", {
				status: 200,
				headers: {
					"content-disposition": 'attachment; filename="crawl.json"',
				},
			});
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await downloadCrawlExport("crawl-1", "json");

		expect(fetchMock).toHaveBeenCalledWith(
			`${getBackendUrl()}${buildCrawlExportPath("crawl-1", "json")}`,
		);
		expect(result.filename).toBe("crawl.json");
	});

	test("event subscription uses the resolved backend API URL", () => {
		const constructedUrls: string[] = [];
		class FakeEventSource {
			constructor(url: string) {
				constructedUrls.push(url);
			}
			addEventListener = mock(() => undefined);
			close = mock(() => undefined);
		}
		globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

		const subscription = subscribeToCrawlEvents("crawl-2", {
			onOpen: () => undefined,
			onError: () => undefined,
			onEvent: () => undefined,
		});
		subscription.close();

		expect(constructedUrls).toEqual([`${getBackendUrl()}${buildCrawlEventsPath("crawl-2")}`]);
	});

	test("preserves API timestamp strings when Eden parses crawl responses", async () => {
		const createdAt = "2026-07-13T10:15:24.000Z";
		globalThis.fetch = mock(async () =>
			Response.json({
				id: "crawl-date-contract",
				target: "https://example.com/",
				status: "starting",
				options: {
					target: "https://example.com/",
					crawlMethod: "full",
					crawlDepth: 2,
					crawlDelay: 1000,
					maxPages: 50,
					maxPagesPerDomain: 0,
					maxConcurrentRequests: 5,
					retryLimit: 3,
					dynamic: true,
					respectRobots: false,
					contentOnly: false,
					saveMedia: false,
				},
				counters: {
					pagesScanned: 0,
					successCount: 0,
					failureCount: 0,
					skippedCount: 0,
					linksFound: 0,
					mediaFiles: 0,
					totalDataKb: 0,
				},
				createdAt,
				startedAt: createdAt,
				updatedAt: createdAt,
				completedAt: null,
				stopReason: null,
				resumable: false,
			}),
		) as unknown as typeof fetch;

		const result = await createCrawl({
			target: "https://example.com/",
			crawlMethod: "full",
			crawlDepth: 2,
			crawlDelay: 1000,
			maxPages: 50,
			maxPagesPerDomain: 0,
			maxConcurrentRequests: 5,
			retryLimit: 3,
			dynamic: true,
			respectRobots: false,
			contentOnly: false,
			saveMedia: false,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.createdAt).toBe(createdAt);
			expect(result.data.createdAt).not.toBeInstanceOf(Date);
		}
	});
});
