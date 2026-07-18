import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildCrawlEventsPath, buildCrawlExportPath } from "../../../shared/contracts/index.js";
import {
	buildBackendApiUrl,
	resolveBackendTransportPolicy,
	resolveBackendUrl,
} from "../backendUrl";
import { downloadCrawlExport, getBackendUrl } from "../client";
import { createCrawl, getCrawlRecoverySnapshot, subscribeToCrawlEvents } from "../crawls";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.EventSource = originalEventSource;
});

describe("API client backend URL resolution", () => {
	test("normalizes one explicit backend endpoint for every transport", () => {
		expect(
			resolveBackendUrl(
				{ VITE_BACKEND_URL: "https://api.example.test/base///" },
				"http://localhost:5173",
			),
		).toBe("https://api.example.test/base");
		expect(
			buildBackendApiUrl("https://api.example.test/base", buildCrawlEventsPath("crawl-1")),
		).toBe("https://api.example.test/base/api/crawls/crawl-1/events");
	});

	test("uses the browser origin when no cross-origin backend is configured", () => {
		expect(resolveBackendUrl({}, "http://localhost:5173")).toBe("http://localhost:5173");
	});

	test("uses same origin outside Vite dev for backend-served static builds", () => {
		expect(resolveBackendUrl({}, "https://crawler.example.test")).toBe(
			"https://crawler.example.test",
		);
	});

	test("projects only the configured HTTP origin into the document CSP", () => {
		expect(resolveBackendTransportPolicy("https://api.example.test/base/path")).toEqual({
			type: "cross-origin",
			connectSource: "https://api.example.test",
		});
		expect(resolveBackendTransportPolicy(undefined).connectSource).toBe("");
	});

	test("rejects backend URLs that cannot be represented as HTTP CSP sources", () => {
		expect(() => resolveBackendTransportPolicy("not a URL")).toThrow(
			"VITE_BACKEND_URL must be an absolute HTTP(S) URL",
		);
		expect(() => resolveBackendTransportPolicy("file:///tmp/backend")).toThrow(
			"VITE_BACKEND_URL must use HTTP or HTTPS",
		);
		expect(() => resolveBackendUrl({ VITE_BACKEND_URL: "https://user@api.example.test" })).toThrow(
			"VITE_BACKEND_URL must not include credentials",
		);
		expect(() =>
			resolveBackendUrl({ VITE_BACKEND_URL: "https://api.example.test/base?mode=direct" }),
		).toThrow("VITE_BACKEND_URL must not include a query or fragment");
	});

	test("derives local proxy and explicit cross-origin transport as exclusive policies", () => {
		expect(resolveBackendTransportPolicy(undefined, { rawPort: "4312" })).toEqual({
			type: "same-origin-proxy",
			connectSource: "",
			proxyTarget: "http://localhost:4312",
		});
		expect(
			resolveBackendTransportPolicy("https://api.example.test/base", {
				rawPort: "invalid-but-unused",
			}),
		).toEqual({
			type: "cross-origin",
			connectSource: "https://api.example.test",
		});
		expect(resolveBackendTransportPolicy(undefined)).toEqual({
			type: "same-origin",
			connectSource: "",
		});
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

		globalThis.fetch = mock(async () =>
			Response.json({
				crawl: result.ok ? result.data : null,
				pages: [],
				pageCount: 0,
			}),
		) as unknown as typeof fetch;
		const durableSnapshot = await getCrawlRecoverySnapshot("crawl-date-contract");
		expect(durableSnapshot.ok).toBe(true);
		if (durableSnapshot.ok) {
			expect(durableSnapshot.data.crawl.createdAt).toBe(createdAt);
		}

		globalThis.fetch = mock(async () =>
			Response.json({
				crawl: result.ok ? result.data : null,
				pages: [{ id: 1, url: "https://example.com/", domain: "example.com" }],
				pageCount: 0,
			}),
		) as unknown as typeof fetch;
		await expect(getCrawlRecoverySnapshot("crawl-date-contract")).resolves.toEqual({
			ok: false,
			error: "Unexpected crawl recovery response",
		});
	});
});
