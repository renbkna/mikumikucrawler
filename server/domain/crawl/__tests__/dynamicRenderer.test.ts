import { describe, expect, mock, test } from "bun:test";
import type { BrowserContext, Route, WebSocketRoute } from "playwright";
import type { HttpClient } from "../../../plugins/security.js";
import {
	configurePinnedBrowserContext,
	createDynamicBrowserContextOptions,
	fulfillRouteWithPinnedHttpClient,
} from "../DynamicRenderer.js";

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
			body: undefined,
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
});
