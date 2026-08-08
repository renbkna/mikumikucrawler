import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildCrawlEventsPath, buildCrawlExportPath } from "../../../shared/contracts/index.js";
import { resolveBackendTransportPolicy, resolveBackendUrl } from "../backendUrl";
import { backendUrl, getCrawlExportUrl } from "../client";
import {
	createCrawl,
	deleteCrawl,
	downloadCrawlExport,
	getCrawlRecoverySnapshot,
	resumeCrawl,
	stopCrawl,
	subscribeToCrawlEvents,
} from "../crawls";

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
		expect(`https://api.example.test/base${buildCrawlEventsPath("crawl-1")}`).toBe(
			"https://api.example.test/base/api/crawls/crawl-1/events",
		);
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
		expect(resolveBackendTransportPolicy("http://api.example.test/base/path")).toEqual({
			type: "cross-origin",
			connectSource: "http://api.example.test",
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

	test("builds the export URL from the resolved backend API URL", () => {
		expect(getCrawlExportUrl("crawl-1", "json")).toBe(
			`${backendUrl}${buildCrawlExportPath("crawl-1", "json")}`,
		);
	});

	test("returns export errors instead of navigating the SPA to an API response", async () => {
		globalThis.fetch = mock(async () =>
			Response.json({ error: "Crawl not found" }, { status: 404 }),
		) as unknown as typeof fetch;

		await expect(downloadCrawlExport("missing-crawl", "json")).resolves.toEqual({
			ok: false,
			error: "Crawl not found",
			status: 404,
		});

		globalThis.fetch = mock(
			async () =>
				new Response("crawl data", {
					headers: { "Content-Disposition": 'attachment; filename="crawl_safe.json"' },
				}),
		) as unknown as typeof fetch;
		const result = await downloadCrawlExport("crawl-1", "json");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.filename).toBe("crawl_safe.json");
			expect(await result.data.blob.text()).toBe("crawl data");
		}
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
			onInvalidEvent: () => undefined,
			onEvent: () => undefined,
		});
		subscription.close();

		expect(constructedUrls).toEqual([`${backendUrl}${buildCrawlEventsPath("crawl-2")}`]);
	});

	test("invalid SSE payloads are observable to the durable-recovery owner", () => {
		const listeners = new Map<string, EventListener>();
		class FakeEventSource {
			addEventListener(type: string, listener: EventListener) {
				listeners.set(type, listener);
			}
			close() {}
		}
		globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
		const onInvalidEvent = mock(() => undefined);

		subscribeToCrawlEvents("crawl-invalid-event", {
			onOpen: () => undefined,
			onError: () => undefined,
			onInvalidEvent,
			onEvent: () => undefined,
		});
		listeners.get("crawl.page")?.(
			new MessageEvent("crawl.page", { data: '{"type":"crawl.page"}' }),
		);

		expect(onInvalidEvent).toHaveBeenCalledTimes(1);
	});

	test("preserves recovery HTTP status for create reconciliation", async () => {
		globalThis.fetch = mock(async () =>
			Response.json({ error: "Crawl not found" }, { status: 404 }),
		) as unknown as typeof fetch;

		await expect(getCrawlRecoverySnapshot("missing-crawl")).resolves.toEqual({
			ok: false,
			error: "Crawl not found",
			status: 404,
		});
	});

	test("preserves stop failure status for durable reconciliation", async () => {
		globalThis.fetch = mock(async () =>
			Response.json({ error: "Only active crawls can be stopped" }, { status: 409 }),
		) as unknown as typeof fetch;

		await expect(stopCrawl("paused-crawl", "force")).resolves.toEqual({
			ok: false,
			error: "Only active crawls can be stopped",
			status: 409,
		});
	});

	test("preserves definite create rejection status", async () => {
		globalThis.fetch = mock(async () =>
			Response.json({ error: "Invalid crawl options" }, { status: 422 }),
		) as unknown as typeof fetch;

		const result = await createCrawl("166ea0f8-570c-4a71-8d7d-39b09734e99b", {
			target: "https://example.com/",
			crawlMethod: "links",
			crawlDepth: 1,
			crawlDelay: 200,
			maxPages: 1,
			maxPagesPerDomain: 0,
			maxConcurrentRequests: 1,
			retryLimit: 0,
			dynamic: false,
			respectRobots: false,
			contentOnly: false,
			saveMedia: false,
		});

		expect(result).toEqual({
			ok: false,
			error: "Invalid crawl options",
			status: 422,
		});
	});

	test("preserves API timestamp strings when Eden parses crawl responses", async () => {
		const createdAt = "2026-07-13T10:15:24.000Z";
		const crawlId = "166ea0f8-570c-4a71-8d7d-39b09734e99b";
		globalThis.fetch = mock(async () =>
			Response.json({
				id: crawlId,
				eventSequence: 0,
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

		const result = await createCrawl(crawlId, {
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
		const durableSnapshot = await getCrawlRecoverySnapshot(crawlId);
		expect(durableSnapshot.ok).toBe(true);
		if (durableSnapshot.ok) {
			expect(durableSnapshot.data.crawl.createdAt).toBe(createdAt);
		}
		await expect(getCrawlRecoverySnapshot("different-crawl")).resolves.toEqual({
			ok: false,
			error: "Crawl recovery response identity mismatch",
		});
		await expect(resumeCrawl("different-crawl")).resolves.toEqual({
			ok: false,
			error: "Crawl response identity mismatch",
		});

		globalThis.fetch = mock(async () =>
			Response.json(result.ok ? result.data : null),
		) as unknown as typeof fetch;
		await expect(stopCrawl("different-crawl")).resolves.toEqual({
			ok: false,
			error: "Crawl response identity mismatch",
		});

		globalThis.fetch = mock(async () => Response.json({ status: "ok" })) as unknown as typeof fetch;
		await expect(deleteCrawl(crawlId)).resolves.toEqual({
			ok: false,
			error: "Unexpected delete response",
		});

		globalThis.fetch = mock(async () =>
			Response.json({
				crawl: result.ok ? result.data : null,
				pages: [{ id: 1, url: "https://example.com/", domain: "example.com" }],
				pageCount: 0,
			}),
		) as unknown as typeof fetch;
		await expect(getCrawlRecoverySnapshot(crawlId)).resolves.toEqual({
			ok: false,
			error: "Unexpected crawl recovery response",
		});
	});
});
