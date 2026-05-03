import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	buildCrawlEventsPath,
	buildCrawlExportPath,
} from "../../../shared/contracts/index.js";
import { subscribeToCrawlEvents } from "../crawls";
import {
	downloadCrawlExport,
	getBackendUrl,
	resolveBackendUrl,
} from "../client";

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
		expect(resolveBackendUrl({ DEV: true }, "http://localhost:5173")).toBe(
			"http://localhost:3000",
		);
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

		expect(constructedUrls).toEqual([
			`${getBackendUrl()}${buildCrawlEventsPath("crawl-2")}`,
		]);
	});
});
