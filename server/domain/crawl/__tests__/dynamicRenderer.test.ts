import { describe, expect, mock, test } from "bun:test";
import type { BrowserContext, Frame, Page, Route, WebSocketRoute } from "playwright";
import type { CrawlOptions } from "../../../../shared/contracts/index.js";
import type { Logger } from "../../../config/logging.js";
import { REQUEST_CONSTANTS } from "../../../constants.js";
import type { HttpClient } from "../../../plugins/security.js";
import {
	configurePinnedBrowserContext,
	createDynamicBrowserContextOptions,
	createDynamicRouteBudget,
	DynamicRenderer,
	extractRenderedSnapshot,
	fulfillRouteWithPinnedHttpClient,
	matchesOwnedSitePattern,
	openBrowserPageWithRetry,
	renderedContentByteLength,
	requiresStaticRepresentationFetch,
} from "../DynamicRenderer.js";

const dynamicOptions: CrawlOptions = {
	target: "https://www.youtube.com/watch?v=test",
	crawlMethod: "full",
	crawlDepth: 1,
	crawlDelay: 200,
	maxPages: 1,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 1,
	retryLimit: 0,
	dynamic: true,
	respectRobots: false,
	contentOnly: false,
	saveMedia: false,
};

type RouteFulfillOptions = Parameters<Route["fulfill"]>[0];

function createRoute(input: {
	url: string;
	method?: string;
	resourceType?: string;
	headers?: Record<string, string>;
	postData?: Buffer;
}) {
	const calls = {
		abort: mock(async () => undefined),
		continue: mock(async () => undefined),
		fulfill: mock(async (_options: RouteFulfillOptions) => undefined),
	};
	const route = {
		request: () => ({
			url: () => input.url,
			method: () => input.method ?? "GET",
			resourceType: () => input.resourceType ?? "document",
			headers: () => input.headers ?? {},
			postDataBuffer: () => input.postData ?? null,
		}),
		abort: calls.abort,
		continue: calls.continue,
		fulfill: calls.fulfill,
	} as unknown as Route;

	return { route, calls };
}

describe("dynamic renderer network contract", () => {
	test("leaves process lifecycle ownership with the server runtime", async () => {
		const listenerCounts = {
			beforeExit: process.listenerCount("beforeExit"),
			exit: process.listenerCount("exit"),
		};
		const logger = {
			debug: mock(() => undefined),
			info: mock(() => undefined),
			warn: mock(() => undefined),
		} as unknown as Logger;
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("unused")),
		};
		const renderer = new DynamicRenderer({ ...dynamicOptions, dynamic: false }, logger, httpClient);

		expect(process.listenerCount("beforeExit")).toBe(listenerCounts.beforeExit);
		expect(process.listenerCount("exit")).toBe(listenerCounts.exit);
		await renderer.close();
	});

	test("measures rendered HTML limits in UTF-8 bytes, not JS characters", () => {
		const content = "a\u0100\u0100";

		expect(content.length).toBe(3);
		expect(renderedContentByteLength(content)).toBe(5);
	});

	test("captures rendered content, metadata, and effective URL in one document observation", async () => {
		const snapshot = {
			content: "<html><title>Final document</title></html>",
			contentLength: 43,
			description: "Final description",
			effectiveUrl: "https://www.youtube.com/shorts/final-id",
			title: "Final document",
		};
		const evaluate = mock(async () => snapshot);
		const page = { evaluate } as unknown as Page;

		await expect(extractRenderedSnapshot(page)).resolves.toEqual(snapshot);
		expect(evaluate).toHaveBeenCalledTimes(1);
	});

	test("matches site policies by hostname ownership and optional path", () => {
		expect(matchesOwnedSitePattern("https://www.youtube.com/watch?v=1", "youtube.com/watch")).toBe(
			true,
		);
		expect(
			matchesOwnedSitePattern("https://youtube.com.evil.test/watch", "youtube.com/watch"),
		).toBe(false);
		expect(
			matchesOwnedSitePattern("https://evil.test/?next=youtube.com/watch", "youtube.com/watch"),
		).toBe(false);
	});

	test("routes supported non-HTML documents back to static representation acquisition", () => {
		expect(requiresStaticRepresentationFetch("application/pdf; charset=binary")).toBe(true);
		expect(requiresStaticRepresentationFetch("application/problem+json")).toBe(true);
		expect(requiresStaticRepresentationFetch("text/html")).toBe(false);
	});

	test("browser contexts block service workers before pages are created", () => {
		expect(createDynamicBrowserContextOptions()).toEqual({
			serviceWorkers: "block",
		});
	});

	test("routes the whole browser context and aborts websocket channels", async () => {
		const route = mock(async () => undefined);
		const routeWebSocket = mock(async (_pattern, handler) => {
			const ws = {
				close: mock(async () => undefined),
			} as unknown as WebSocketRoute;
			await handler(ws);
			expect(ws.close).toHaveBeenCalledWith({
				code: 1008,
				reason: "WebSockets are not allowed during crawling",
			});
		});
		const context = {
			route,
			routeWebSocket,
		} as unknown as BrowserContext;
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("unused")),
		};

		await configurePinnedBrowserContext(context, httpClient);

		expect(route).toHaveBeenCalledWith("**/*", expect.any(Function));
		expect(routeWebSocket).toHaveBeenCalledWith("**/*", expect.any(Function));
	});

	test("grants localhost capability only to the exact seed document request", async () => {
		let handler: ((route: Route) => Promise<void>) | undefined;
		const context = {
			route: mock(async (_pattern: string, next: (route: Route) => Promise<void>) => {
				handler = next;
			}),
			routeWebSocket: mock(async () => undefined),
		} as unknown as BrowserContext;
		const fetch = mock(async (_request: Parameters<HttpClient["fetch"]>[0]) => new Response("ok"));
		const httpClient: HttpClient = { fetch };
		await configurePinnedBrowserContext(context, httpClient, undefined, "http://localhost:3000/");
		if (!handler) throw new Error("Expected browser route handler");

		await handler(createRoute({ url: "http://localhost:3000/", resourceType: "document" }).route);
		await handler(
			createRoute({ url: "http://localhost:3000/app.js", resourceType: "script" }).route,
		);

		expect(fetch.mock.calls[0]?.[0]).toMatchObject({ allowLocalhostOnInitialRequest: true });
		expect(fetch.mock.calls[1]?.[0]).not.toHaveProperty("allowLocalhostOnInitialRequest");
	});

	test("fulfills HTTP browser requests through the pinned HTTP client", async () => {
		const { route, calls } = createRoute({
			url: "https://example.com/app",
			headers: { accept: "text/html" },
		});
		const fetch = mock(async () => {
			return new Response("<html><main>pinned</main></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		});
		const httpClient: HttpClient = { fetch };

		await fulfillRouteWithPinnedHttpClient(route, httpClient);

		expect(fetch).toHaveBeenCalledWith({
			url: "https://example.com/app",
			headers: { accept: "text/html" },
			method: "GET",
			signal: undefined,
		});
		expect(calls.continue).not.toHaveBeenCalled();
		expect(calls.abort).not.toHaveBeenCalled();
		expect(calls.fulfill).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 200,
				headers: expect.objectContaining({ "content-type": "text/html" }),
			}),
		);
	});

	test("strips stale compression metadata from decoded fulfilled responses", async () => {
		const { route, calls } = createRoute({
			url: "https://example.com/app",
			headers: { accept: "text/html", "accept-encoding": "gzip, br" },
		});
		const decodedBody =
			"<html><main>decoded response body larger than compressed bytes</main></html>";
		const fetch = mock(async () => {
			return new Response(decodedBody, {
				status: 200,
				headers: {
					"cache-control": "max-age=60",
					"content-encoding": "br",
					"content-length": "19",
					"content-type": "text/html",
				},
			});
		});
		const httpClient: HttpClient = { fetch };

		await fulfillRouteWithPinnedHttpClient(route, httpClient);

		expect(calls.abort).not.toHaveBeenCalled();
		expect(calls.fulfill).toHaveBeenCalledTimes(1);
		const fulfillPayload = calls.fulfill.mock.calls.at(0)?.[0];
		if (!fulfillPayload) {
			throw new Error("Expected dynamic route to be fulfilled");
		}
		expect(fulfillPayload).toMatchObject({
			status: 200,
			headers: {
				"cache-control": "max-age=60",
				"content-type": "text/html",
			},
			body: Buffer.from(decodedBody),
		});
		expect(fulfillPayload.headers).not.toHaveProperty("content-encoding");
		expect(fulfillPayload.headers).not.toHaveProperty("content-length");
	});

	test("aborts oversized HTTP browser responses before buffering", async () => {
		let bodyRead = false;
		const { route, calls } = createRoute({
			url: "https://example.com/huge-script.js",
			resourceType: "script",
		});
		const fetch = mock(async () => {
			return {
				status: 200,
				headers: new Headers({
					"content-length": String(REQUEST_CONSTANTS.MAX_RESPONSE_BYTES + 1),
				}),
				body: {
					getReader() {
						bodyRead = true;
						throw new Error("body should not be read");
					},
				},
			} as unknown as Response;
		});
		const httpClient: HttpClient = { fetch };

		await fulfillRouteWithPinnedHttpClient(route, httpClient);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(calls.abort).toHaveBeenCalled();
		expect(calls.fulfill).not.toHaveBeenCalled();
		expect(bodyRead).toBe(false);
	});

	test("classifies successful unsupported documents before browser buffering", async () => {
		const { route, calls } = createRoute({ url: "https://example.com/download" });
		const response = new Response("installer bytes", {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
		});
		const cancel = mock(async () => undefined);
		Object.defineProperty(response.body, "cancel", { value: cancel });
		const httpClient: HttpClient = { fetch: mock(async () => response) };

		const result = await fulfillRouteWithPinnedHttpClient(route, httpClient);

		expect(result).toEqual({
			type: "aborted",
			reason: "unsupported-content",
			contentType: "application/octet-stream",
			statusCode: 200,
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(calls.abort).toHaveBeenCalledTimes(1);
		expect(calls.fulfill).not.toHaveBeenCalled();
	});

	test("hands supported JSON documents to raw static acquisition before browser buffering", async () => {
		const { route, calls } = createRoute({ url: "https://example.com/data.json" });
		const response = new Response('{"value":1}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		const cancel = mock(async () => undefined);
		Object.defineProperty(response.body, "cancel", { value: cancel });
		const httpClient: HttpClient = { fetch: mock(async () => response) };

		const result = await fulfillRouteWithPinnedHttpClient(route, httpClient);

		expect(result).toEqual({ type: "aborted", reason: "static-representation" });
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(calls.abort).toHaveBeenCalledTimes(1);
		expect(calls.fulfill).not.toHaveBeenCalled();
	});

	test("aborts state-changing browser requests before they reach the HTTP client", async () => {
		const { route, calls } = createRoute({
			url: "https://example.com/account",
			method: "POST",
			postData: Buffer.from("action=delete"),
		});
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("must not run")),
		};

		const result = await fulfillRouteWithPinnedHttpClient(route, httpClient);

		expect(result).toEqual({ type: "aborted", reason: "unsupported-method" });
		expect(httpClient.fetch).not.toHaveBeenCalled();
		expect(calls.abort).toHaveBeenCalledTimes(1);
		expect(calls.fulfill).not.toHaveBeenCalled();
	});

	test("shares request and byte budgets across dynamic page resources", async () => {
		const budget = createDynamicRouteBudget(2, 5);
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("1234")),
		};
		const first = createRoute({ url: "https://example.com/app.js", resourceType: "script" });
		const second = createRoute({ url: "https://example.com/data", resourceType: "fetch" });
		const third = createRoute({ url: "https://example.com/extra", resourceType: "fetch" });

		await expect(
			fulfillRouteWithPinnedHttpClient(first.route, httpClient, undefined, false, budget),
		).resolves.toEqual({ type: "fulfilled" });
		await expect(
			fulfillRouteWithPinnedHttpClient(second.route, httpClient, undefined, false, budget),
		).resolves.toEqual({ type: "aborted", reason: "response-budget" });
		await expect(
			fulfillRouteWithPinnedHttpClient(third.route, httpClient, undefined, false, budget),
		).resolves.toEqual({ type: "aborted", reason: "request-budget" });

		expect(first.calls.fulfill).toHaveBeenCalledTimes(1);
		expect(second.calls.abort).toHaveBeenCalledTimes(1);
		expect(third.calls.abort).toHaveBeenCalledTimes(1);
		expect(httpClient.fetch).toHaveBeenCalledTimes(2);
	});

	test("does not let HTTP subresources continue on Playwright native networking", async () => {
		const { route, calls } = createRoute({
			url: "https://example.com/app.js",
			resourceType: "script",
		});
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("console.log('ok')")),
		};

		await fulfillRouteWithPinnedHttpClient(route, httpClient);

		expect(calls.continue).not.toHaveBeenCalled();
		expect(calls.fulfill).toHaveBeenCalled();
	});

	test("aborts unsupported protocols and bulky resources before fetching", async () => {
		const image = createRoute({
			url: "https://example.com/image.png",
			resourceType: "image",
		});
		const ftp = createRoute({ url: "ftp://example.com/file" });
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("unused")),
		};

		await fulfillRouteWithPinnedHttpClient(image.route, httpClient);
		await fulfillRouteWithPinnedHttpClient(ftp.route, httpClient);

		expect(httpClient.fetch).not.toHaveBeenCalled();
		expect(image.calls.abort).toHaveBeenCalled();
		expect(ftp.calls.abort).toHaveBeenCalled();
	});

	test("waits for a detected consent wall to become actionable and verifies dismissal", async () => {
		let frameEvaluationCount = 0;
		const frame = {
			evaluate: mock(async () => {
				frameEvaluationCount += 1;
				return frameEvaluationCount >= 2;
			}),
		} as unknown as Frame;
		let pageEvaluationCount = 0;
		const page = {
			evaluate: mock(async () => {
				pageEvaluationCount += 1;
				if (pageEvaluationCount === 1) return "Before you continue to YouTube";
				if (pageEvaluationCount === 2) {
					throw new Error("Execution context was destroyed during consent navigation");
				}
				if (pageEvaluationCount === 3) throw new Error("Frame was detached");
				return "Video content";
			}),
			frames: () => [frame],
		} as unknown as Page;
		const logger = {
			debug: mock(() => undefined),
			info: mock(() => undefined),
			warn: mock(() => undefined),
		} as unknown as Logger;
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("unused")),
		};
		const renderer = new DynamicRenderer(dynamicOptions, logger, httpClient);

		const result = await renderer.handleConsentModals(page, "https://www.youtube.com/watch?v=test");

		expect(result).toEqual({ detected: true, bypassed: true });
		expect(frame.evaluate).toHaveBeenCalledTimes(2);
		expect(page.evaluate).toHaveBeenCalledTimes(4);
	});

	test("retries page acquisition once after Crawlee retires a failed browser controller", async () => {
		const page = {} as Page;
		const newPage = mock(async () => {
			if (newPage.mock.calls.length === 1) {
				throw new Error(
					"browserController.newPage() failed: stale\nCause: Target page, context or browser has been closed.",
				);
			}
			return page;
		});
		const onRetry = mock(() => undefined);

		await expect(openBrowserPageWithRetry(newPage, onRetry)).resolves.toBe(page);
		expect(newPage).toHaveBeenCalledTimes(2);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});
