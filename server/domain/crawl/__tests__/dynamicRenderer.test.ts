import { describe, expect, mock, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { Browser, BrowserContext, Frame, Page, Route, WebSocketRoute } from "playwright";
import type { CrawlOptions } from "../../../../shared/contracts/index.js";
import { silentLogger } from "../../../__tests__/runtimeFixture.js";
import { DYNAMIC_RENDERER_CONSTANTS, REQUEST_CONSTANTS } from "../../../constants.js";
import { type HttpClient, OutboundPolicyError } from "../../../outbound/HttpClient.js";
import { OperationTimeoutError } from "../../../utils/timeout.js";
import {
	configurePinnedBrowserContext,
	createDynamicBrowserContextOptions,
	createDynamicBrowserLaunchArgs,
	createDynamicRouteBudget,
	createDynamicSubrequestAdmission,
	DynamicRenderer,
	extractRenderedSnapshot,
	fulfillRouteWithPinnedHttpClient,
	openBrowserPageWithRetry,
	readBoundedDocumentText,
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
	frame?: Frame;
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
			frame: () => input.frame,
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
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("unused")),
		};
		const renderer = new DynamicRenderer(
			{ ...dynamicOptions, dynamic: false },
			silentLogger,
			httpClient,
		);

		expect(process.listenerCount("beforeExit")).toBe(listenerCounts.beforeExit);
		expect(process.listenerCount("exit")).toBe(listenerCounts.exit);
		await renderer.close();
	});

	test("captures rendered content, metadata, and effective URL in one document observation", async () => {
		const snapshot = {
			content: "<html><title>Final document</title></html>",
			contentLength: 43,
			description: "Final description",
			effectiveUrl: "https://www.youtube.com/shorts/final-id",
			title: "Final document",
		};
		const evaluate = mock(async (_callback: unknown, _limits: object) => snapshot);
		const page = { evaluate } as unknown as Page;

		await expect(extractRenderedSnapshot(page)).resolves.toEqual(snapshot);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(evaluate.mock.calls[0]?.[1]).toEqual({
			maxBytes: REQUEST_CONSTANTS.MAX_TEXT_DOCUMENT_BYTES,
			maxNodes: 50_000,
		});
	});

	test("rejects oversized UTF-8 markup before materializing outerHTML", async () => {
		let serialized = false;
		const root = {
			nodeType: 1,
			tagName: "HTML",
			attributes: [{ name: "界".repeat(20), value: "" }],
			childNodes: [],
			get outerHTML() {
				serialized = true;
				throw new Error("outerHTML must not be materialized");
			},
		};
		const evaluate = mock(async (callback: (limits: object) => unknown) =>
			runInNewContext(`(${callback.toString()})({ maxBytes: 64, maxNodes: 50_000 })`, {
				document: { documentElement: root },
				window: { location: { href: "https://example.com/" } },
				Node: { ELEMENT_NODE: 1, COMMENT_NODE: 8 },
			}),
		);

		await expect(extractRenderedSnapshot({ evaluate } as unknown as Page)).resolves.toBe(
			"tooLarge",
		);
		expect(serialized).toBe(false);
	});

	test("bounds consent text returned from the browser document", () => {
		const nodes = ["abcdefgh", "ijklmnop", "must-not-be-read"].map((nodeValue) => ({
			nodeType: 3,
			nodeValue,
		}));
		let index = 0;
		const text = runInNewContext(
			`(${readBoundedDocumentText.toString()})({ maxChars: 12, maxNodes: 2, visibleOnly: false })`,
			{
				document: {
					body: {},
					createTreeWalker: () => ({
						currentNode: undefined as (typeof nodes)[number] | undefined,
						nextNode() {
							this.currentNode = nodes[index];
							index += 1;
							return this.currentNode !== undefined;
						},
					}),
				},
				Node: { TEXT_NODE: 3 },
				NodeFilter: { SHOW_ALL: 0xffff_ffff },
			},
		);

		expect(text).toBe("abcdefgh ijk");
		expect(index).toBe(3);
	});

	test("retires the page and settles evaluation before an abort escapes", async () => {
		const evaluation = Promise.withResolvers<never>();
		const evaluationStarted = Promise.withResolvers<void>();
		let pageClosed = false;
		const page = {
			evaluate: mock(() => {
				evaluationStarted.resolve();
				return evaluation.promise;
			}),
			close: mock(async () => {
				pageClosed = true;
				evaluation.reject(new Error("page closed"));
			}),
		} as unknown as Page;
		const controller = new AbortController();
		const snapshot = extractRenderedSnapshot(page, controller.signal);

		await evaluationStarted.promise;
		controller.abort(new Error("item deadline"));

		await expect(snapshot).rejects.toThrow("item deadline");
		expect(pageClosed).toBe(true);
		expect(page.close).toHaveBeenCalledTimes(1);
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

	test("browser launch disables QUIC channels that bypass request routing", () => {
		expect(createDynamicBrowserLaunchArgs()).toContain("--disable-quic");
	});

	test("blocks direct page networking and routes the remaining browser context", async () => {
		let initScript: (() => void) | undefined;
		const addInitScript = mock(async (script: () => void) => {
			initScript = script;
		});
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
			addInitScript,
			route,
			routeWebSocket,
		} as unknown as BrowserContext;
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("unused")),
		};

		await configurePinnedBrowserContext(context, httpClient);
		if (!initScript) throw new Error("Expected a browser initialization script");
		const realm = {
			RTCPeerConnection: class {},
			webkitRTCPeerConnection: class {},
			WebTransport: class {},
		};
		runInNewContext(`(${initScript.toString()})()`, realm);

		for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"] as const) {
			expect(Object.getOwnPropertyDescriptor(realm, name)).toMatchObject({
				value: undefined,
				writable: false,
				configurable: false,
			});
		}
		expect(route).toHaveBeenCalledWith("**/*", expect.any(Function));
		expect(routeWebSocket).toHaveBeenCalledWith("**/*", expect.any(Function));
	});

	test("grants localhost capability only to the exact seed document request", async () => {
		let handler: ((route: Route) => Promise<void>) | undefined;
		const context = {
			addInitScript: mock(async () => undefined),
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

	test("blocks an unauthorized client-side main-frame navigation before dispatch", async () => {
		let handler: ((route: Route) => Promise<void>) | undefined;
		const mainFrame = {} as Frame;
		const context = {
			addInitScript: mock(async () => undefined),
			route: mock(async (_pattern: string, next: (route: Route) => Promise<void>) => {
				handler = next;
			}),
			routeWebSocket: mock(async () => undefined),
		} as unknown as BrowserContext;
		const fetch = mock(
			async () => new Response("<html>ok</html>", { headers: { "content-type": "text/html" } }),
		);
		const authorizeDestination = mock(async (url: string) => {
			if (url === "https://blocked.example/final") {
				throw new OutboundPolicyError("crawl-policy", "destination denied");
			}
		});
		const onDocumentResult = mock(() => undefined);
		await configurePinnedBrowserContext(
			context,
			{ fetch },
			undefined,
			undefined,
			onDocumentResult,
			authorizeDestination,
			mainFrame,
		);
		if (!handler) throw new Error("Expected browser route handler");

		await handler(createRoute({ url: "https://source.example/start", frame: mainFrame }).route);
		const blocked = createRoute({
			url: "https://blocked.example/final",
			frame: mainFrame,
		});
		await handler(blocked.route);

		expect(authorizeDestination).toHaveBeenCalledWith("https://blocked.example/final", undefined);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(blocked.calls.abort).toHaveBeenCalledTimes(1);
		expect(onDocumentResult).toHaveBeenLastCalledWith(
			{
				type: "aborted",
				reason: "policy",
				message: "destination denied",
			},
			"https://blocked.example/final",
		);
	});

	test("does not authorize an HTTP redirect destination twice when the browser follows it", async () => {
		let handler: ((route: Route) => Promise<void>) | undefined;
		const mainFrame = {} as Frame;
		const context = {
			addInitScript: mock(async () => undefined),
			route: mock(async (_pattern: string, next: (route: Route) => Promise<void>) => {
				handler = next;
			}),
			routeWebSocket: mock(async () => undefined),
		} as unknown as BrowserContext;
		const fetch = mock(async (request: Parameters<HttpClient["fetch"]>[0]) => {
			if (request.url === "https://source.example/start") {
				await request.authorizeRedirect?.({
					fromUrl: request.url,
					toUrl: "https://final.example/page",
					statusCode: 302,
					hopNumber: 1,
				});
				return new Response(null, {
					status: 302,
					headers: { location: "https://final.example/page" },
				});
			}
			return new Response("<html>final</html>", {
				status: 451,
				headers: {
					"content-type": "text/html; charset=utf-8",
					"x-robots-tag": "noindex, nofollow",
				},
			});
		});
		const authorizeDestination = mock(async () => undefined);
		const onDocumentResult = mock(() => undefined);
		await configurePinnedBrowserContext(
			context,
			{ fetch },
			undefined,
			undefined,
			onDocumentResult,
			authorizeDestination,
			mainFrame,
		);
		if (!handler) throw new Error("Expected browser route handler");

		await handler(createRoute({ url: "https://source.example/start", frame: mainFrame }).route);
		await handler(createRoute({ url: "https://final.example/page", frame: mainFrame }).route);

		expect(authorizeDestination).toHaveBeenCalledTimes(1);
		expect(authorizeDestination).toHaveBeenCalledWith("https://final.example/page", undefined);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(onDocumentResult).toHaveBeenLastCalledWith(
			{
				type: "fulfilled",
				documentResponse: {
					url: "https://final.example/page",
					statusCode: 451,
					contentType: "text/html; charset=utf-8",
					xRobotsTag: "noindex, nofollow",
					retryAfter: null,
				},
			},
			"https://final.example/page",
		);
	});

	test("keeps iframe documents out of main-document policy and result ownership", async () => {
		let handler: ((route: Route) => Promise<void>) | undefined;
		const mainFrame = {} as Frame;
		const childFrame = {} as Frame;
		const context = {
			addInitScript: mock(async () => undefined),
			route: mock(async (_pattern: string, next: (route: Route) => Promise<void>) => {
				handler = next;
			}),
			routeWebSocket: mock(async () => undefined),
		} as unknown as BrowserContext;
		const fetch = mock(
			async (_request: Parameters<HttpClient["fetch"]>[0]) =>
				new Response("<html>frame</html>", { headers: { "content-type": "text/html" } }),
		);
		const authorizeDestination = mock(async () => undefined);
		const onDocumentResult = mock(() => undefined);
		await configurePinnedBrowserContext(
			context,
			{ fetch },
			undefined,
			undefined,
			onDocumentResult,
			authorizeDestination,
			mainFrame,
		);
		if (!handler) throw new Error("Expected browser route handler");

		await handler(
			createRoute({
				url: "https://frame.example/embed",
				resourceType: "document",
				frame: childFrame,
			}).route,
		);

		expect(authorizeDestination).not.toHaveBeenCalled();
		expect(onDocumentResult).not.toHaveBeenCalled();
		expect(fetch.mock.calls[0]?.[0]).toMatchObject({ redirect: "manual" });
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

		const result = await fulfillRouteWithPinnedHttpClient(route, httpClient);

		expect(fetch).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/app",
				headers: { accept: "text/html" },
				method: "GET",
				signal: undefined,
				redirect: "manual",
			}),
		);
		expect(calls.continue).not.toHaveBeenCalled();
		expect(calls.abort).not.toHaveBeenCalled();
		expect(calls.fulfill).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 200,
				headers: expect.objectContaining({ "content-type": "text/html" }),
			}),
		);
		expect(result).toEqual({
			type: "fulfilled",
			documentResponse: {
				url: "https://example.com/app",
				statusCode: 200,
				contentType: "text/html",
				xRobotsTag: null,
				retryAfter: null,
			},
		});
	});

	test("returns authorized document redirects to the browser navigation owner", async () => {
		const { route, calls } = createRoute({ url: "https://example.com/start" });
		const httpClient: HttpClient = {
			fetch: mock(
				async () =>
					new Response(null, {
						status: 302,
						headers: {
							"content-type": "application/json",
							location: "https://example.com/final",
						},
					}),
			),
		};

		await expect(fulfillRouteWithPinnedHttpClient(route, httpClient)).resolves.toEqual({
			type: "fulfilled",
		});
		expect(httpClient.fetch).toHaveBeenCalledWith(expect.objectContaining({ redirect: "manual" }));
		expect(calls.fulfill).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 302,
				headers: expect.objectContaining({ location: "https://example.com/final" }),
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
					"content-length": String(
						DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MAX_RESPONSE_BYTES_PER_PAGE + 1,
					),
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

	test("applies the parse-safe limit to browser document responses", async () => {
		let bodyRead = false;
		const { route, calls } = createRoute({
			url: "https://example.com/huge-document",
			resourceType: "document",
		});
		const httpClient: HttpClient = {
			fetch: async () =>
				({
					status: 200,
					headers: new Headers({
						"content-type": "text/html",
						"content-length": String(REQUEST_CONSTANTS.MAX_TEXT_DOCUMENT_BYTES + 1),
					}),
					body: {
						getReader() {
							bodyRead = true;
							throw new Error("body should not be read");
						},
					},
				}) as unknown as Response,
		};

		await fulfillRouteWithPinnedHttpClient(route, httpClient);

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

		expect(result).toEqual({
			type: "aborted",
			reason: "static-representation",
			url: "https://example.com/data.json",
		});
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
			fulfillRouteWithPinnedHttpClient(first.route, httpClient, { budget }),
		).resolves.toEqual({ type: "fulfilled" });
		await expect(
			fulfillRouteWithPinnedHttpClient(second.route, httpClient, { budget }),
		).resolves.toEqual({ type: "aborted", reason: "response-budget" });
		await expect(
			fulfillRouteWithPinnedHttpClient(third.route, httpClient, { budget }),
		).resolves.toEqual({ type: "aborted", reason: "request-budget" });

		expect(first.calls.fulfill).toHaveBeenCalledTimes(1);
		expect(second.calls.abort).toHaveBeenCalledTimes(1);
		expect(third.calls.abort).toHaveBeenCalledTimes(1);
		expect(httpClient.fetch).toHaveBeenCalledTimes(2);
	});

	test("serializes concurrent body reads against one shared byte budget", async () => {
		const budget = createDynamicRouteBudget(2, 5);
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("1234")),
		};
		const routes = [
			createRoute({ url: "https://example.com/a.js", resourceType: "script" }),
			createRoute({ url: "https://example.com/b.js", resourceType: "script" }),
		];

		const results = await Promise.all(
			routes.map(({ route }) => fulfillRouteWithPinnedHttpClient(route, httpClient, { budget })),
		);

		expect(results).toContainEqual({ type: "fulfilled" });
		expect(results).toContainEqual({ type: "aborted", reason: "response-budget" });
		expect(routes.map(({ calls }) => calls.fulfill.mock.calls.length)).toEqual([1, 0]);
		expect(routes.map(({ calls }) => calls.abort.mock.calls.length)).toEqual([0, 1]);
	});

	test("disposes a fetched response when cancellation wins while waiting for the byte budget", async () => {
		const firstReadStarted = Promise.withResolvers<void>();
		const releaseFirstRead = Promise.withResolvers<void>();
		const firstResponse = new Response(
			new ReadableStream({
				async pull(controller) {
					firstReadStarted.resolve();
					await releaseFirstRead.promise;
					controller.enqueue(new TextEncoder().encode("1"));
					controller.close();
				},
			}),
		);
		const secondResponse = new Response("2");
		const cancelSecond = mock(async () => undefined);
		Object.defineProperty(secondResponse.body, "cancel", { value: cancelSecond });
		let request = 0;
		const httpClient: HttpClient = {
			fetch: mock(async () => (request++ === 0 ? firstResponse : secondResponse)),
		};
		const budget = createDynamicRouteBudget(2, 5);
		const first = fulfillRouteWithPinnedHttpClient(
			createRoute({ url: "https://example.com/first.js", resourceType: "script" }).route,
			httpClient,
			{ budget },
		);
		await firstReadStarted.promise;
		const controller = new AbortController();
		const second = fulfillRouteWithPinnedHttpClient(
			createRoute({ url: "https://example.com/second.js", resourceType: "script" }).route,
			httpClient,
			{ budget, signal: controller.signal },
		);
		controller.abort(new Error("cancelled"));

		await expect(second).resolves.toMatchObject({ type: "aborted", reason: "transport-failure" });
		expect(cancelSecond).toHaveBeenCalledTimes(1);
		releaseFirstRead.resolve();
		await expect(first).resolves.toEqual({ type: "fulfilled" });
	});

	test("rejects a successful document without Content-Type before reading its body", async () => {
		const { route, calls } = createRoute({ url: "https://example.com/" });
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response(new Uint8Array([1, 2, 3]))),
		};

		await expect(fulfillRouteWithPinnedHttpClient(route, httpClient)).resolves.toEqual({
			type: "aborted",
			reason: "unsupported-content",
			contentType: "",
			statusCode: 200,
		});
		expect(calls.abort).toHaveBeenCalledTimes(1);
		expect(calls.fulfill).not.toHaveBeenCalled();
	});

	test("bounds dynamic subrequest concurrency and same-host dispatch rate", async () => {
		const admission = createDynamicSubrequestAdmission(2, 0);
		const releaseFirst = await admission.acquire("https://one.example/a.js");
		const releaseSecond = await admission.acquire("https://two.example/b.js");
		let thirdAdmitted = false;
		const third = admission.acquire("https://three.example/c.js").then((release) => {
			thirdAdmitted = true;
			return release;
		});
		await Promise.resolve();
		expect(thirdAdmitted).toBe(false);
		releaseFirst();
		const releaseThird = await third;
		expect(thirdAdmitted).toBe(true);
		releaseSecond();
		releaseThird();

		const delayedAdmission = createDynamicSubrequestAdmission(1, 20);
		const releaseInitial = await delayedAdmission.acquire("https://same.example/a.js");
		releaseInitial();
		const startedAt = Date.now();
		const releaseDelayed = await delayedAdmission.acquire("https://same.example/b.js");
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
		releaseDelayed();
	});

	test("applies same-host dispatch spacing to internal subrequest redirects", async () => {
		const admission = createDynamicSubrequestAdmission(1, 20);
		const dispatchTimes: number[] = [];
		const { route } = createRoute({
			url: "https://same.example/start.js",
			resourceType: "script",
		});
		const httpClient: HttpClient = {
			fetch: async (request) => {
				dispatchTimes.push(Date.now());
				await request.authorizeRedirect?.({
					fromUrl: request.url,
					toUrl: "https://same.example/final.js",
					statusCode: 302,
					hopNumber: 1,
				});
				dispatchTimes.push(Date.now());
				return new Response("ok");
			},
		};

		await fulfillRouteWithPinnedHttpClient(route, httpClient, {
			admitSubrequest: admission,
			isMainDocument: false,
		});

		expect((dispatchTimes[1] ?? 0) - (dispatchTimes[0] ?? 0)).toBeGreaterThanOrEqual(15);
	});

	test("charges internal redirect hops to the same dynamic request budget", async () => {
		const budget = createDynamicRouteBudget(2, 100);
		const { route, calls } = createRoute({
			url: "https://example.com/start",
			resourceType: "script",
		});
		const httpClient: HttpClient = {
			fetch: async (request) => {
				await request.authorizeRedirect?.({
					fromUrl: request.url,
					toUrl: "https://example.com/one",
					statusCode: 302,
					hopNumber: 1,
				});
				await request.authorizeRedirect?.({
					fromUrl: "https://example.com/one",
					toUrl: "https://example.com/two",
					statusCode: 302,
					hopNumber: 2,
				});
				return new Response("must not run");
			},
		};

		await expect(
			fulfillRouteWithPinnedHttpClient(route, httpClient, { budget }),
		).resolves.toMatchObject({ type: "aborted", reason: "request-budget" });
		expect(calls.abort).toHaveBeenCalledTimes(1);
		expect(calls.fulfill).not.toHaveBeenCalled();
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
		const evaluateFrame = mock(async (_callback: unknown, _options: unknown) => {
			frameEvaluationCount += 1;
			return frameEvaluationCount >= 2;
		});
		const frame = { evaluate: evaluateFrame } as unknown as Frame;
		let pageEvaluationCount = 0;
		const evaluatePage = mock(async (_callback: unknown, _options: unknown) => {
			pageEvaluationCount += 1;
			if (pageEvaluationCount === 1) return "Before you continue to YouTube";
			if (pageEvaluationCount === 2) {
				throw new Error("Execution context was destroyed during consent navigation");
			}
			if (pageEvaluationCount === 3) throw new Error("Frame was detached");
			return "Video content";
		});
		const page = { evaluate: evaluatePage, frames: () => [frame] } as unknown as Page;
		const httpClient: HttpClient = {
			fetch: mock(async () => new Response("unused")),
		};
		const renderer = new DynamicRenderer(dynamicOptions, silentLogger, httpClient);

		const result = await renderer.handleConsentModals(page, "https://www.youtube.com/watch?v=test");

		expect(result).toEqual({ detected: true, bypassed: true });
		expect(evaluateFrame).toHaveBeenCalledTimes(2);
		expect(evaluateFrame.mock.calls[0]?.[1]).toMatchObject({
			maxControls: 500,
			maxControlTextChars: 512,
			maxControlTextNodes: 100,
			maxNodes: 50_000,
		});
		expect(evaluatePage).toHaveBeenCalledTimes(4);
		expect(evaluatePage.mock.calls[0]?.[1]).toEqual({
			maxChars: 256 * 1024,
			maxNodes: 50_000,
			visibleOnly: false,
		});
	});

	test("retries page acquisition once after recoverable browser errors", async () => {
		const errors = [
			new Error(
				"browserController.newPage() failed: stale\nCause: Target page, context or browser has been closed.",
			),
			new OperationTimeoutError("Rendered document snapshot", 10_000),
		];
		for (const error of errors) {
			const page = {} as Page;
			const newPage = mock(async () => {
				if (newPage.mock.calls.length === 1) throw error;
				return page;
			});
			const onRetry = mock(() => undefined);

			await expect(openBrowserPageWithRetry(newPage, onRetry)).resolves.toBe(page);
			expect(newPage).toHaveBeenCalledTimes(2);
			expect(onRetry).toHaveBeenCalledTimes(1);
		}
	});

	test("relaunches before rendering when the crawl browser disconnected", async () => {
		const renderer = new DynamicRenderer(dynamicOptions, silentLogger, {
			fetch: mock(async () => new Response("unused")),
		});
		(renderer as unknown as { browser: Browser | null }).browser = {
			isConnected: () => false,
		} as Browser;
		renderer.launchBrowser = mock(async () => {
			throw new Error("replacement browser unavailable");
		});

		await expect(
			renderer.render({
				url: dynamicOptions.target,
				domain: "www.youtube.com",
				depth: 0,
				retries: 0,
			}),
		).resolves.toEqual({ type: "staticFallback", reason: "renderer-unavailable" });
		expect(renderer.launchBrowser).toHaveBeenCalledTimes(1);
	});

	test("shares one browser acquisition across concurrent relaunches", async () => {
		const pendingBrowser = Promise.withResolvers<Browser>();
		const launch = mock(async () => pendingBrowser.promise);
		const closeContext = mock(async () => undefined);
		const closeBrowser = mock(async () => undefined);
		let page!: Page;
		const context = {
			newPage: mock(async () => page),
			close: closeContext,
		} as unknown as BrowserContext;
		page = { context: () => context } as unknown as Page;
		const browser = {
			isConnected: () => true,
			newContext: mock(async () => context),
			close: closeBrowser,
		} as unknown as Browser;
		const renderer = new DynamicRenderer(
			dynamicOptions,
			silentLogger,
			{ fetch: mock(async () => new Response("unused")) },
			launch,
		);

		const first = renderer.launchBrowser();
		const second = renderer.launchBrowser();
		expect(launch).toHaveBeenCalledTimes(1);
		pendingBrowser.resolve(browser);

		await Promise.all([first, second]);
		expect(browser.newContext).toHaveBeenCalledTimes(1);
		expect(closeContext).toHaveBeenCalledTimes(1);
		await renderer.close();
		expect(closeBrowser).toHaveBeenCalledTimes(1);
	});

	test("lets shutdown finish during a stalled browser launch", async () => {
		const pendingBrowser = Promise.withResolvers<Browser>();
		const closeBrowser = mock(async () => undefined);
		const lateBrowser = {
			isConnected: () => true,
			close: closeBrowser,
		} as unknown as Browser;
		const renderer = new DynamicRenderer(
			dynamicOptions,
			silentLogger,
			{ fetch: mock(async () => new Response("unused")) },
			mock(async () => pendingBrowser.promise),
		);

		const launchAttempt = renderer.launchBrowser();
		const closing = renderer.close();
		const closedPromptly = await Promise.race([
			closing.then(() => true),
			Bun.sleep(50).then(() => false),
		]);
		pendingBrowser.resolve(lateBrowser);

		expect(closedPromptly).toBe(true);
		await expect(launchAttempt).rejects.toThrow("closed during browser acquisition");
		expect(closeBrowser).toHaveBeenCalledTimes(1);
	});

	test("rejects an aborted page acquisition and disposes its late page", async () => {
		const pendingPage = Promise.withResolvers<Page>();
		const disposed = Promise.withResolvers<void>();
		const close = mock(async () => disposed.resolve());
		const controller = new AbortController();
		const acquisition = openBrowserPageWithRetry(
			() => pendingPage.promise,
			mock(() => undefined),
			controller.signal,
			{ isCurrent: () => true, close },
		);

		controller.abort(new Error("document deadline"));
		await expect(acquisition).rejects.toThrow("document deadline");
		pendingPage.resolve({} as Page);
		await disposed.promise;
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("disposes a page whose acquisition finishes after renderer ownership ends", async () => {
		let release!: (page: Page) => void;
		let owned = true;
		const page = {} as Page;
		const close = mock(async () => undefined);
		const acquisition = openBrowserPageWithRetry(
			() => new Promise<Page>((resolve) => (release = resolve)),
			mock(() => undefined),
			undefined,
			{ isCurrent: () => owned, close },
		);
		owned = false;
		release(page);

		await expect(acquisition).rejects.toThrow("ownership ended");
		expect(close).toHaveBeenCalledWith(page);
	});
});
