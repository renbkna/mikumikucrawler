import { setTimeout as sleep } from "node:timers/promises";
import {
	type Browser,
	type BrowserContext,
	type BrowserContextOptions,
	chromium,
	type Frame,
	type Page,
	type Route,
	type WebSocketRoute,
} from "playwright";
import type { CrawlOptions } from "../../../shared/contracts/index.js";
import { normalizeCanonicalHttpUrl } from "../../../shared/url.js";
import { resolveChromiumExecutable } from "../../config/browser.js";
import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import {
	DYNAMIC_RENDERER_CONSTANTS,
	FETCH_HEADERS,
	REQUEST_CONSTANTS,
	TIMEOUT_CONSTANTS,
} from "../../constants.js";
import { type HttpClient, isOutboundPolicyError } from "../../outbound/HttpClient.js";
import {
	isJsonContentType,
	isPdfContentType,
	isSupportedDocumentContentType,
	maxProcessableDocumentBytes,
} from "../../processors/contentTypes.js";
import { getErrorMessage } from "../../utils/helpers.js";
import { disposeResponseBody, readLimitedResponseBody } from "../../utils/responseBody.js";
import { OperationTimeoutError, runWithTimeout } from "../../utils/timeout.js";
import { type WorkLease, WorkPermitPool } from "../../utils/WorkPermitPool.js";
import type { QueueItem } from "./CrawlQueue.js";
import {
	CONSENT_ACTION_MARKERS,
	CONSENT_BUTTON_SELECTORS,
	CONSENT_NEGATIVE_ACTION_MARKERS,
	isConsentWallText,
	requiresStrictConsentBypass,
} from "./consent.js";
import type { DestinationAuthorizer } from "./FetchService.js";

/**
 * Dynamic renderer contract:
 * - owns one crawl-scoped browser and one isolated context per rendered page
 * - classifies dynamic fetches as success, consentBlocked, or static fallback
 * - never uses Playwright's native HTTP(S) network path; browser requests are
 *   fulfilled through the same pinned HTTP client used by static crawling
 */
interface InitializeResult {
	dynamicEnabled: boolean;
	fallbackLog?: string;
}

interface DynamicRenderResult {
	content: string;
	effectiveUrl: string;
	statusCode: number;
	contentType: string;
	contentLength: number;
	title: string;
	description: string;
	xRobotsTag?: string | null;
	retryAfter?: string | null;
}

type BrowserLauncher = (options: Parameters<typeof chromium.launch>[0]) => Promise<Browser>;

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

interface DynamicRenderConsentBlocked {
	type: "consentBlocked";
	message: string;
	statusCode: number;
}

interface DynamicRenderSuccess {
	type: "success";
	result: DynamicRenderResult;
}

interface DynamicStaticFallback {
	type: "staticFallback";
	reason: "non-html" | "renderer-unavailable" | "content-unavailable";
	targetUrl?: string;
}

interface DynamicTransportFailure {
	type: "transportFailure";
	message: string;
}

interface DynamicPolicyBlocked {
	type: "policyBlocked";
	message: string;
}

interface DynamicTooLarge {
	type: "tooLarge";
}

interface DynamicUnsupported {
	type: "unsupported";
	contentType: string;
	statusCode: number;
}

type DynamicRenderAttempt =
	| DynamicRenderSuccess
	| DynamicRenderConsentBlocked
	| DynamicStaticFallback
	| DynamicTransportFailure
	| DynamicPolicyBlocked
	| DynamicTooLarge
	| DynamicUnsupported;

interface ConsentBypassResult {
	detected: boolean;
	bypassed: boolean;
}

interface RenderedSnapshot {
	content: string;
	contentLength: number;
	description: string;
	effectiveUrl: string;
	title: string;
}

const CONSENT_POLL_INTERVAL_MS = 100;
const MAX_CONSENT_CONTROLS = 500;
const MAX_CONSENT_CONTROL_TEXT_CHARS = 512;
const MAX_CONSENT_CONTROL_TEXT_NODES = 100;
const MAX_CONSENT_TEXT_CHARS = 256 * 1024;
const MAX_RENDERED_DOM_NODES = 50_000;
const BROWSER_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface DynamicRouteBudget {
	remainingRequests: number;
	remainingBytes: number;
}

class DynamicRouteBudgetError extends Error {}

export function createDynamicRouteBudget(
	maxRequests: number = DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MAX_REQUESTS_PER_PAGE,
	maxBytes: number = DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MAX_RESPONSE_BYTES_PER_PAGE,
): DynamicRouteBudget {
	return { remainingRequests: maxRequests, remainingBytes: maxBytes };
}

type DynamicSubrequestAdmission = {
	acquire(url: string, signal?: AbortSignal): Promise<WorkLease>;
	waitForDispatch(url: string, signal?: AbortSignal): Promise<void>;
};

export function createDynamicSubrequestAdmission(
	maxConcurrent: number = DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MAX_CONCURRENT_SUBREQUESTS,
	minimumDelayMs: number = DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MIN_SUBREQUEST_DELAY_MS,
): DynamicSubrequestAdmission {
	const permits = new WorkPermitPool(maxConcurrent);
	const nextAllowedAt = new Map<string, number>();
	const waitForDispatch = async (url: string, signal?: AbortSignal) => {
		const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
		const now = Date.now();
		const dispatchAt = Math.max(now, nextAllowedAt.get(hostname) ?? 0);
		nextAllowedAt.set(hostname, dispatchAt + minimumDelayMs);
		if (dispatchAt > now) {
			await sleep(dispatchAt - now, undefined, signal ? { signal } : undefined);
		}
	};
	return {
		waitForDispatch,
		async acquire(url, signal) {
			const release = await permits.acquire(signal);
			try {
				await waitForDispatch(url, signal);
				return release;
			} catch (error) {
				release();
				throw error;
			}
		},
	};
}

interface DynamicDocumentResponse {
	url: string;
	statusCode: number;
	contentType: string;
	xRobotsTag: string | null;
	retryAfter: string | null;
}

type DynamicRouteResult =
	| { type: "fulfilled"; documentResponse?: DynamicDocumentResponse }
	| { type: "continued" }
	| { type: "aborted"; reason: "static-representation"; url: string }
	| {
			type: "aborted";
			reason: "unsupported-content";
			contentType: string;
			statusCode: number;
	  }
	| {
			type: "aborted";
			reason:
				| "policy"
				| "unsupported-method"
				| "request-budget"
				| "response-budget"
				| "response-too-large"
				| "transport-failure";
			message?: string;
	  };

interface DynamicRouteRequestOptions {
	signal?: AbortSignal;
	allowLocalhostOnInitialRequest?: boolean;
	budget?: DynamicRouteBudget;
	authorizeDocumentRequest?: DestinationAuthorizer;
	authorizeDocumentRedirect?: DestinationAuthorizer;
	admitSubrequest?: DynamicSubrequestAdmission;
	isMainDocument?: boolean;
}

function classifyDocumentRouteFailure(
	result: DynamicRouteResult,
	itemUrl: string,
): DynamicRenderAttempt | undefined {
	if (result.type !== "aborted") return undefined;
	if (result.reason === "policy" || result.reason === "unsupported-method") {
		return {
			type: "policyBlocked",
			message: result.message ?? `Dynamic document navigation denied for ${itemUrl}`,
		};
	}
	if (result.reason === "static-representation") {
		return { type: "staticFallback", reason: "non-html", targetUrl: result.url };
	}
	if (result.reason === "unsupported-content") {
		return {
			type: "unsupported",
			contentType: result.contentType,
			statusCode: result.statusCode,
		};
	}
	if (result.reason === "request-budget") {
		return {
			type: "policyBlocked",
			message: result.message ?? `Dynamic document request budget exhausted for ${itemUrl}`,
		};
	}
	if (result.reason === "response-budget" || result.reason === "response-too-large") {
		return { type: "tooLarge" };
	}
	return {
		type: "transportFailure",
		message: result.message ?? `Dynamic document transport failed for ${itemUrl}`,
	};
}

export function requiresStaticRepresentationFetch(contentType: string): boolean {
	return isJsonContentType(contentType) || isPdfContentType(contentType);
}

function isRecoverableBrowserError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err instanceof OperationTimeoutError || err.name === "TimeoutError") return true;

	const message = err.message;
	return (
		message.includes("Target page, context or browser has been closed") ||
		message.includes("Navigation failed because page crashed") ||
		message.includes("net::ERR_ABORTED") ||
		message.includes("Execution context was destroyed") ||
		message.includes("Frame was detached")
	);
}

export function readBoundedDocumentText(options: {
	maxChars: number;
	maxNodes: number;
	visibleOnly: boolean;
}): string {
	const body = document.body;
	if (!body) return "";

	const walker = document.createTreeWalker(body, NodeFilter.SHOW_ALL);
	let text = "";
	let visitedNodes = 0;
	while (walker.nextNode()) {
		visitedNodes += 1;
		if (visitedNodes > options.maxNodes || text.length >= options.maxChars) break;
		const node = walker.currentNode;
		if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue) continue;
		if (options.visibleOnly) {
			const parent = node.parentElement;
			if (!parent || parent.hidden || parent.getClientRects().length === 0) continue;
			const style = getComputedStyle(parent);
			if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
				continue;
			}
		}
		if (text.length > 0) text += " ";
		text += node.nodeValue.slice(0, options.maxChars - text.length);
	}
	return text;
}

async function readConsentBodyText(
	page: Page,
	signal: AbortSignal,
	visibleOnly: boolean,
): Promise<string> {
	while (true) {
		try {
			return await page.evaluate(readBoundedDocumentText, {
				maxChars: MAX_CONSENT_TEXT_CHARS,
				maxNodes: MAX_RENDERED_DOM_NODES,
				visibleOnly,
			});
		} catch (error) {
			if (!isRecoverableBrowserError(error)) throw error;
			await sleep(CONSENT_POLL_INTERVAL_MS, undefined, { signal });
		}
	}
}

function shouldSkipSecurityValidation(url: string): boolean {
	return url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:");
}

export async function openBrowserPageWithRetry(
	createPage: () => Promise<Page>,
	onRetry: (error: unknown) => void,
	signal?: AbortSignal,
	ownership?: { isCurrent(): boolean; close(page: Page): Promise<void> },
): Promise<Page> {
	const accept = async (page: Page): Promise<Page> => {
		if (!signal?.aborted && (ownership?.isCurrent() ?? true)) return page;
		await ownership?.close(page);
		signal?.throwIfAborted();
		throw new Error("Browser page acquisition completed after renderer ownership ended");
	};
	const acquire = () => waitForAbort(createPage().then(accept), signal);
	try {
		return await acquire();
	} catch (error) {
		signal?.throwIfAborted();
		if (!isRecoverableBrowserError(error)) throw error;
		onRetry(error);
		return acquire();
	}
}

async function runPageOperationWithDeadline<T>(options: {
	page: Page;
	timeoutMs: number;
	operationName: string;
	signal?: AbortSignal;
	run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
	let closePromise: Promise<void> | undefined;
	const closePage = () => {
		closePromise ??= options.page.close({ runBeforeUnload: false }).catch(() => undefined);
	};

	return runWithTimeout({
		timeoutMs: options.timeoutMs,
		operationName: options.operationName,
		...(options.signal ? { signal: options.signal } : {}),
		run: async (operationSignal) => {
			const closeOnAbort = () => closePage();
			if (operationSignal.aborted) {
				closePage();
			} else {
				operationSignal.addEventListener("abort", closeOnAbort, { once: true });
			}
			try {
				operationSignal.throwIfAborted();
				return await options.run(operationSignal);
			} finally {
				operationSignal.removeEventListener("abort", closeOnAbort);
				await closePromise;
			}
		},
	});
}

export async function extractRenderedSnapshot(
	page: Page,
	signal?: AbortSignal,
): Promise<RenderedSnapshot | "tooLarge"> {
	return runPageOperationWithDeadline({
		page,
		timeoutMs: 10_000,
		operationName: "Rendered document snapshot",
		...(signal ? { signal } : {}),
		run: () =>
			page.evaluate(
				({ maxBytes, maxNodes }) => {
					const root = document.documentElement;
					if (!root) {
						return {
							content: "",
							contentLength: 0,
							description: "",
							effectiveUrl: window.location.href,
							title: document.title || "",
						};
					}
					let upperBound = 0;
					let visitedNodes = 0;
					const addSerializedText = (value: string, attribute = false) => {
						for (let index = 0; index < value.length; index++) {
							const codeUnit = value.charCodeAt(index);
							if (codeUnit <= 0x7f) {
								upperBound +=
									codeUnit === 0x26
										? 5
										: codeUnit === 0x3c || codeUnit === 0x3e
											? 4
											: attribute && codeUnit === 0x22
												? 6
												: 1;
							} else if (codeUnit <= 0x7ff) {
								upperBound += 2;
							} else if (
								codeUnit >= 0xd800 &&
								codeUnit <= 0xdbff &&
								index + 1 < value.length &&
								value.charCodeAt(index + 1) >= 0xdc00 &&
								value.charCodeAt(index + 1) <= 0xdfff
							) {
								upperBound += 4;
								index += 1;
							} else {
								upperBound += 3;
							}
							if (upperBound > maxBytes) return false;
						}
						return true;
					};
					const stack: Node[] = [root];
					while (stack.length > 0) {
						const node = stack.pop();
						if (!node) break;
						visitedNodes += 1;
						if (visitedNodes > maxNodes) return "tooLarge" as const;
						if (node.nodeType === Node.ELEMENT_NODE) {
							const element = node as Element;
							upperBound += 5;
							if (!addSerializedText(element.tagName) || !addSerializedText(element.tagName)) {
								return "tooLarge" as const;
							}
							for (const attribute of element.attributes) {
								upperBound += 4;
								if (!addSerializedText(attribute.name)) return "tooLarge" as const;
								if (!addSerializedText(attribute.value, true)) return "tooLarge" as const;
							}
						} else if (node.nodeType === Node.COMMENT_NODE) {
							upperBound += 7;
							if (!addSerializedText(node.nodeValue ?? "")) return "tooLarge" as const;
						} else if (!addSerializedText(node.nodeValue ?? "")) {
							return "tooLarge" as const;
						}
						if (upperBound > maxBytes) return "tooLarge" as const;
						for (let index = node.childNodes.length - 1; index >= 0; index--) {
							const child = node.childNodes[index];
							if (child) stack.push(child);
						}
					}

					const content = root.outerHTML;
					let contentLength = 0;
					for (let index = 0; index < content.length; index++) {
						const codeUnit = content.charCodeAt(index);
						if (codeUnit <= 0x7f) {
							contentLength += 1;
						} else if (codeUnit <= 0x7ff) {
							contentLength += 2;
						} else if (
							codeUnit >= 0xd800 &&
							codeUnit <= 0xdbff &&
							index + 1 < content.length &&
							content.charCodeAt(index + 1) >= 0xdc00 &&
							content.charCodeAt(index + 1) <= 0xdfff
						) {
							contentLength += 4;
							index += 1;
						} else {
							contentLength += 3;
						}
						if (contentLength > maxBytes) return "tooLarge" as const;
					}

					return {
						content,
						contentLength,
						description:
							document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
						effectiveUrl: window.location.href,
						title: document.title || "",
					};
				},
				{
					maxBytes: REQUEST_CONSTANTS.MAX_TEXT_DOCUMENT_BYTES,
					maxNodes: MAX_RENDERED_DOM_NODES,
				},
			),
	});
}

function createRouteFulfillHeaders(headers: Headers): Record<string, string> {
	const fulfilledHeaders = new Headers(headers);
	fulfilledHeaders.delete("content-encoding");
	fulfilledHeaders.delete("content-length");
	return Object.fromEntries(fulfilledHeaders);
}

export async function fulfillRouteWithPinnedHttpClient(
	route: Route,
	httpClient: HttpClient,
	options: DynamicRouteRequestOptions = {},
): Promise<DynamicRouteResult> {
	const request = route.request();
	const requestUrl = request.url();
	const isDocument = request.resourceType() === "document";
	const isMainDocument = isDocument && (options.isMainDocument ?? true);
	const budget = options.budget ?? createDynamicRouteBudget();
	if (shouldSkipSecurityValidation(requestUrl)) {
		await route.continue();
		return { type: "continued" };
	}

	const parsed = new URL(requestUrl);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		await route.abort();
		return { type: "aborted", reason: "policy" };
	}

	if (["image", "stylesheet", "font", "media"].includes(request.resourceType())) {
		await route.abort();
		return { type: "aborted", reason: "policy" };
	}

	const method = request.method().toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		await route.abort();
		return { type: "aborted", reason: "unsupported-method" };
	}

	if (budget.remainingRequests <= 0) {
		await route.abort();
		return { type: "aborted", reason: "request-budget" };
	}
	budget.remainingRequests -= 1;

	let releaseSubrequest: WorkLease | undefined;
	try {
		if (!isMainDocument && options.admitSubrequest) {
			releaseSubrequest = await options.admitSubrequest.acquire(requestUrl, options.signal);
		}
		await options.authorizeDocumentRequest?.(requestUrl, options.signal);
		const response = await httpClient.fetch({
			url: requestUrl,
			headers: request.headers(),
			method,
			signal: options.signal,
			...(isDocument ? { redirect: "manual" as const } : {}),
			...(options.allowLocalhostOnInitialRequest ? { allowLocalhostOnInitialRequest: true } : {}),
			authorizeRedirect: async (hop, redirectSignal) => {
				if (!isDocument) {
					if (budget.remainingRequests <= 0) {
						throw new DynamicRouteBudgetError("Dynamic redirect request budget exhausted");
					}
					budget.remainingRequests -= 1;
					await options.admitSubrequest?.waitForDispatch(hop.toUrl, redirectSignal);
				}
				await options.authorizeDocumentRedirect?.(hop.toUrl, redirectSignal);
			},
		});
		const contentType = response.headers.get("content-type") ?? "";
		const isBrowserRedirect =
			isDocument &&
			BROWSER_REDIRECT_STATUSES.has(response.status) &&
			response.headers.has("location");
		if (isDocument && !isBrowserRedirect) {
			if (requiresStaticRepresentationFetch(contentType)) {
				await disposeResponseBody(response);
				await route.abort();
				return { type: "aborted", reason: "static-representation", url: requestUrl };
			}
			if (response.ok && contentType && !isSupportedDocumentContentType(contentType)) {
				await disposeResponseBody(response);
				await route.abort();
				return {
					type: "aborted",
					reason: "unsupported-content",
					contentType,
					statusCode: response.status,
				};
			}
		}
		if (isBrowserRedirect) {
			await disposeResponseBody(response);
			await route.fulfill({
				status: response.status,
				headers: createRouteFulfillHeaders(response.headers),
			});
			return { type: "fulfilled" };
		}
		const contentLimit = isDocument
			? maxProcessableDocumentBytes(contentType)
			: Number.POSITIVE_INFINITY;
		const responseBudgetOwnsLimit = budget.remainingBytes < contentLimit;
		const body = await readLimitedResponseBody(
			response,
			Math.min(contentLimit, budget.remainingBytes),
			options.signal,
		);
		if (body.type === "tooLarge") {
			if (responseBudgetOwnsLimit) budget.remainingBytes = 0;
			await route.abort();
			return {
				type: "aborted",
				reason: responseBudgetOwnsLimit ? "response-budget" : "response-too-large",
			};
		}
		budget.remainingBytes -= body.contentLength;
		await route.fulfill({
			status: response.status,
			headers: createRouteFulfillHeaders(response.headers),
			body: Buffer.from(body.bytes),
		});
		return {
			type: "fulfilled",
			...(isMainDocument
				? {
						documentResponse: {
							url: requestUrl,
							statusCode: response.status,
							contentType,
							xRobotsTag: response.headers.get("x-robots-tag"),
							retryAfter: response.headers.get("retry-after"),
						},
					}
				: {}),
		};
	} catch (error) {
		await route.abort();
		if (error instanceof DynamicRouteBudgetError) {
			return { type: "aborted", reason: "request-budget", message: error.message };
		}
		if (isOutboundPolicyError(error)) {
			return { type: "aborted", reason: "policy", message: error.message };
		}
		return {
			type: "aborted",
			reason: "transport-failure",
			message: getErrorMessage(error),
		};
	} finally {
		releaseSubrequest?.();
	}
}

export function createDynamicBrowserContextOptions(): BrowserContextOptions {
	return { serviceWorkers: "block" };
}

export function createDynamicBrowserLaunchArgs(): string[] {
	return [
		"--disable-dev-shm-usage",
		"--disable-gpu",
		"--disable-blink-features=AutomationControlled",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-quic",
	];
}

async function abortWebSocketRoute(route: WebSocketRoute): Promise<void> {
	await route.close({
		code: 1008,
		reason: "WebSockets are not allowed during crawling",
	});
}

export async function configurePinnedBrowserContext(
	context: BrowserContext,
	httpClient: HttpClient,
	signal?: AbortSignal,
	seedUrl?: string,
	onDocumentResult?: (result: DynamicRouteResult, url: string) => void,
	authorizeDocumentDestination?: DestinationAuthorizer,
	mainFrame?: Frame,
): Promise<void> {
	await context.addInitScript(() => {
		Object.defineProperties(globalThis, {
			RTCPeerConnection: { value: undefined, writable: false, configurable: false },
			webkitRTCPeerConnection: { value: undefined, writable: false, configurable: false },
			WebTransport: { value: undefined, writable: false, configurable: false },
		});
	});
	let seedCapabilityAvailable = seedUrl !== undefined;
	let initialMainDocumentAvailable = true;
	let preauthorizedDocumentUrl: string | undefined;
	const budget = createDynamicRouteBudget();
	const admitSubrequest = createDynamicSubrequestAdmission();
	await context.route("**/*", async (route) => {
		const request = route.request();
		let isMainDocument = request.resourceType() === "document";
		if (isMainDocument && mainFrame) {
			try {
				isMainDocument = request.frame() === mainFrame;
			} catch {
				isMainDocument = false;
			}
		}
		const isInitialMainDocument = isMainDocument && initialMainDocumentAvailable;
		if (isInitialMainDocument) {
			initialMainDocumentAvailable = false;
		}
		const isPreauthorizedDocument = isMainDocument && preauthorizedDocumentUrl === request.url();
		if (isMainDocument) {
			preauthorizedDocumentUrl = undefined;
		}
		const useSeedCapability =
			seedCapabilityAvailable && isMainDocument && request.url() === seedUrl;
		if (useSeedCapability) {
			seedCapabilityAvailable = false;
		}
		const result = await fulfillRouteWithPinnedHttpClient(route, httpClient, {
			signal,
			allowLocalhostOnInitialRequest: useSeedCapability,
			budget,
			authorizeDocumentRequest:
				isMainDocument && !isInitialMainDocument && !isPreauthorizedDocument
					? authorizeDocumentDestination
					: undefined,
			authorizeDocumentRedirect:
				isMainDocument && authorizeDocumentDestination
					? async (url, redirectSignal) => {
							await authorizeDocumentDestination(url, redirectSignal);
							preauthorizedDocumentUrl = url;
						}
					: undefined,
			admitSubrequest,
			isMainDocument,
		});
		if (isMainDocument) {
			onDocumentResult?.(result, request.url());
		}
	});
	await context.routeWebSocket("**/*", abortWebSocketRoute);
}

export class DynamicRenderer {
	private readonly options: CrawlOptions;
	private readonly logger: Logger;
	private readonly httpClient: HttpClient;
	private browser: Browser | null;
	private enabled: boolean;
	private launchPromise: Promise<void> | null;
	private closePromise: Promise<void> | null;
	private closed = false;

	constructor(
		options: CrawlOptions,
		logger: Logger,
		httpClient: HttpClient,
		private readonly launch: BrowserLauncher = (launchOptions) => chromium.launch(launchOptions),
	) {
		this.options = options;
		this.logger = logger;
		this.httpClient = httpClient;
		this.browser = null;
		this.enabled = options.dynamic;
		this.launchPromise = null;
		this.closePromise = null;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	disableDynamic(reason?: string): void {
		this.enabled = false;
		if (reason) {
			this.logger.warn(reason);
		}
	}

	async initialize(signal?: AbortSignal): Promise<InitializeResult> {
		if (this.closed) return { dynamicEnabled: false };
		signal?.throwIfAborted();
		if (!this.isEnabled()) {
			return { dynamicEnabled: false };
		}

		const memoryUsage = process.memoryUsage();
		const rssMb = Math.round(memoryUsage.rss / 1024 / 1024);
		const heapUsedMb = Math.round(memoryUsage.heapUsed / 1024 / 1024);
		const isLowMemory = rssMb > config.memoryThreshold;
		this.logger.info(
			`${isLowMemory ? "⚠️" : "✅"} Memory: ${rssMb}MB RSS | Heap: ${heapUsedMb}MB | ${isLowMemory ? `RSS exceeds the configured ${config.memoryThreshold}MB browser threshold` : "Memory levels OK for dynamic crawling"}`,
		);

		if (isLowMemory) {
			this.disableDynamic("Skipping Playwright due to constrained memory");
			return {
				dynamicEnabled: false,
				fallbackLog:
					"Falling back to static crawling: environment lacks sufficient memory for dynamic rendering",
			};
		}

		const closeOnAbort = () => {
			void this.close();
		};
		signal?.addEventListener("abort", closeOnAbort, { once: true });
		try {
			await this.launchBrowser(signal);
			signal?.throwIfAborted();
			return { dynamicEnabled: this.isEnabled() };
		} catch (err) {
			signal?.throwIfAborted();
			await this.closeResources();
			this.disableDynamic(`Failed to launch Playwright: ${getErrorMessage(err)}`);
			return {
				dynamicEnabled: false,
				fallbackLog: "Falling back to static crawling: dynamic renderer failed to start",
			};
		} finally {
			signal?.removeEventListener("abort", closeOnAbort);
		}
	}

	async launchBrowser(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (!this.isEnabled() || this.closed) {
			return;
		}

		if (this.browser?.isConnected()) {
			return;
		}

		this.launchPromise ??= this.acquireBrowser(signal).finally(() => {
			this.launchPromise = null;
		});
		await waitForAbort(this.launchPromise, signal);
		signal?.throwIfAborted();
	}

	private async acquireBrowser(signal?: AbortSignal): Promise<void> {
		if (!this.isEnabled() || this.closed || this.browser?.isConnected()) return;
		this.browser = null;

		this.logger.info("Launching Playwright (Chromium)...");
		const browserExecutable = resolveChromiumExecutable(
			config.browser.executablePath,
			chromium.executablePath(),
		);
		if (browserExecutable.source === "invalid-configured") {
			throw new Error(
				`Configured Chromium executable does not exist: ${browserExecutable.executablePath}`,
			);
		}
		if (browserExecutable.source === "missing") {
			throw new Error(
				"No Chromium executable found. Run `bunx playwright install chromium` or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.",
			);
		}
		if (browserExecutable.source === "system") {
			this.logger.info(`Using system Chromium executable: ${browserExecutable.executablePath}`);
		}
		const executablePath =
			browserExecutable.source === "configured" || browserExecutable.source === "system"
				? browserExecutable.executablePath
				: undefined;

		const browser = await this.launch({
			chromiumSandbox: true,
			headless: true,
			timeout: TIMEOUT_CONSTANTS.DOCUMENT_FETCH,
			args: createDynamicBrowserLaunchArgs(),
			...(executablePath !== undefined ? { executablePath } : {}),
		});
		if (this.closed || signal?.aborted) {
			await browser.close().catch(() => undefined);
			signal?.throwIfAborted();
			throw new Error("Dynamic renderer closed during browser acquisition");
		}
		this.browser = browser;

		const warmupPage = await this.openPage(signal);
		try {
			if (this.closed) throw new Error("Dynamic renderer closed during browser warmup");
		} finally {
			await this.closePageSafely(warmupPage);
		}
		this.logger.info("Playwright launched successfully");
	}

	private async openPage(signal?: AbortSignal): Promise<Page> {
		const browser = this.browser;
		if (!browser) {
			throw new Error("Cannot open a page before the browser is initialized");
		}

		const createPage = async () => {
			const context = await browser.newContext(createDynamicBrowserContextOptions());
			let closePromise: Promise<void> | undefined;
			const closeContext = () => (closePromise ??= context.close().catch(() => undefined));
			const closeOnAbort = () => {
				void closeContext();
			};
			signal?.addEventListener("abort", closeOnAbort, { once: true });
			try {
				signal?.throwIfAborted();
				const page = await context.newPage();
				signal?.throwIfAborted();
				return page;
			} catch (error) {
				await closeContext();
				throw error;
			} finally {
				signal?.removeEventListener("abort", closeOnAbort);
			}
		};

		return openBrowserPageWithRetry(
			createPage,
			(error) => {
				this.logger.debug(
					`Browser page acquisition failed; retrying with a fresh context: ${getErrorMessage(error)}`,
				);
			},
			signal,
			{
				isCurrent: () => !this.closed && this.browser === browser,
				close: (page) => this.closePageSafely(page),
			},
		);
	}

	private async configurePage(
		page: Page,
		item: QueueItem,
		signal?: AbortSignal,
		onDocumentResult?: (result: DynamicRouteResult, url: string) => void,
		authorizeDocumentDestination?: DestinationAuthorizer,
	): Promise<void> {
		await page.setViewportSize(DYNAMIC_RENDERER_CONSTANTS.VIEWPORT);
		await page.setExtraHTTPHeaders({
			Accept: FETCH_HEADERS.Accept,
			"Accept-Language": FETCH_HEADERS["Accept-Language"],
			"Accept-Encoding": FETCH_HEADERS["Accept-Encoding"],
			"User-Agent": FETCH_HEADERS["User-Agent"],
			DNT: "1",
		});

		await configurePinnedBrowserContext(
			page.context(),
			this.httpClient,
			signal,
			item.url === this.options.target ? item.url : undefined,
			onDocumentResult,
			authorizeDocumentDestination,
			page.mainFrame(),
		);

		page.on("dialog", (dialog) => {
			dialog.dismiss().catch((err) => {
				this.logger.debug(`Failed to dismiss dialog: ${getErrorMessage(err)}`);
			});
		});
	}

	private async safeExtractContent(
		page: Page,
		signal?: AbortSignal,
	): Promise<RenderedSnapshot | "tooLarge" | null> {
		try {
			if (page.isClosed()) {
				return null;
			}
			return await extractRenderedSnapshot(page, signal);
		} catch (err) {
			if (isRecoverableBrowserError(err)) {
				this.logger.debug(`Content extraction failed for page: ${getErrorMessage(err)}`);
				return null;
			}

			throw err;
		}
	}

	async render(
		item: QueueItem,
		signal?: AbortSignal,
		authorizeDestination?: DestinationAuthorizer,
	): Promise<DynamicRenderAttempt> {
		signal?.throwIfAborted();
		if (!this.isEnabled()) {
			return { type: "staticFallback", reason: "renderer-unavailable" };
		}

		if (!this.browser?.isConnected()) {
			try {
				await this.launchBrowser(signal);
			} catch (err) {
				signal?.throwIfAborted();
				await this.closeResources();
				this.disableDynamic(`Failed to relaunch Playwright: ${getErrorMessage(err)}`);
				return { type: "staticFallback", reason: "renderer-unavailable" };
			}
		}

		if (!this.browser) {
			return { type: "staticFallback", reason: "renderer-unavailable" };
		}

		const page = await this.openPage(signal);
		let abortCleanup: Promise<void> | undefined;
		let documentRouteFailure: DynamicRenderAttempt | undefined;
		const documentState: { response: DynamicDocumentResponse | null; url: string } = {
			response: null,
			url: item.url,
		};
		const closeOnAbort = () => {
			abortCleanup ??= this.closePageSafely(page);
		};
		signal?.addEventListener("abort", closeOnAbort, { once: true });

		try {
			signal?.throwIfAborted();
			await this.configurePage(
				page,
				item,
				signal,
				(result, url) => {
					documentState.response =
						result.type === "fulfilled" ? (result.documentResponse ?? null) : null;
					documentState.url = documentState.response?.url ?? url;
					documentRouteFailure ??= classifyDocumentRouteFailure(result, item.url);
				},
				authorizeDestination,
			);
			signal?.throwIfAborted();

			await page.goto(item.url, {
				waitUntil: "domcontentloaded",
				timeout: TIMEOUT_CONSTANTS.DOCUMENT_FETCH,
			});
			signal?.throwIfAborted();
			if (documentRouteFailure) {
				return documentRouteFailure;
			}

			const consentBypass = await this.handleConsentModals(page, item.url, signal);
			signal?.throwIfAborted();
			if (documentRouteFailure) {
				return documentRouteFailure;
			}
			if (
				consentBypass.detected &&
				!consentBypass.bypassed &&
				requiresStrictConsentBypass(item.url)
			) {
				const statusCode = documentState.response?.statusCode ?? 200;
				return {
					type: "consentBlocked",
					message: `Consent wall could not be bypassed for ${item.url}`,
					statusCode: statusCode >= 400 ? statusCode : 403,
				};
			}

			signal?.throwIfAborted();
			if (documentRouteFailure) {
				return documentRouteFailure;
			}

			const finalDocumentResponse = documentState.response;
			const extracted = await this.safeExtractContent(page, signal);
			signal?.throwIfAborted();
			if (documentRouteFailure) {
				return documentRouteFailure;
			}
			if (finalDocumentResponse !== documentState.response) {
				return {
					type: "staticFallback",
					reason: "content-unavailable",
					targetUrl: documentState.url,
				};
			}
			if (!extracted || extracted === "tooLarge") {
				return extracted === "tooLarge"
					? { type: "tooLarge" }
					: {
							type: "staticFallback",
							reason: "content-unavailable",
							targetUrl: documentState.url,
						};
			}

			const normalizedEffectiveUrl = normalizeCanonicalHttpUrl(extracted.effectiveUrl);
			if ("error" in normalizedEffectiveUrl) {
				return {
					type: "staticFallback",
					reason: "content-unavailable",
					targetUrl: documentState.url,
				};
			}

			if (documentRouteFailure) {
				return documentRouteFailure;
			}
			const statusCode = finalDocumentResponse?.statusCode ?? 200;
			return {
				type: "success",
				result: {
					content: extracted.content,
					effectiveUrl: normalizedEffectiveUrl.url,
					statusCode,
					contentType: finalDocumentResponse?.contentType ?? "text/html",
					contentLength: extracted.contentLength,
					title: extracted.title,
					description: extracted.description || "",
					xRobotsTag: finalDocumentResponse?.xRobotsTag ?? null,
					retryAfter: finalDocumentResponse?.retryAfter ?? null,
				},
			};
		} catch (err) {
			signal?.throwIfAborted();

			if (documentRouteFailure) return documentRouteFailure;

			if (isRecoverableBrowserError(err)) {
				this.logger.debug(
					`Recoverable browser error for ${item.url}, falling back to static crawling: ${getErrorMessage(err)}`,
				);
				return {
					type: "staticFallback",
					reason: "content-unavailable",
					targetUrl: documentState.url,
				};
			}

			this.logger.warn(
				`Unexpected error during dynamic rendering of ${item.url}: ${getErrorMessage(err)}`,
			);
			return {
				type: "staticFallback",
				reason: "content-unavailable",
				targetUrl: documentState.url,
			};
		} finally {
			signal?.removeEventListener("abort", closeOnAbort);
			await (abortCleanup ?? this.closePageSafely(page));
		}
	}

	async handleConsentModals(
		page: Page,
		url: string,
		signal?: AbortSignal,
	): Promise<ConsentBypassResult> {
		const EVAL_TIMEOUT_MS = DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.CONSENT_EVAL;
		const CLEAR_TIMEOUT_MS = DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.CONSENT_CLEAR;

		try {
			const bodyText = await runPageOperationWithDeadline({
				page,
				timeoutMs: EVAL_TIMEOUT_MS,
				operationName: "Consent body text extraction",
				...(signal ? { signal } : {}),
				run: (operationSignal) => readConsentBodyText(page, operationSignal, false),
			});

			if (!isConsentWallText(bodyText)) {
				return { detected: false, bypassed: false };
			}

			this.logger.info(`Consent wall detected on ${url}. Attempting to bypass...`);

			let clicked = false;
			const actionDeadline = Date.now() + EVAL_TIMEOUT_MS;
			while (!clicked && Date.now() < actionDeadline) {
				for (const frame of page.frames()) {
					try {
						clicked = await runPageOperationWithDeadline({
							page,
							timeoutMs: Math.max(1, actionDeadline - Date.now()),
							operationName: "Consent button evaluation",
							...(signal ? { signal } : {}),
							run: () =>
								frame.evaluate(
									({
										selectors,
										actionMarkers,
										negativeActionMarkers,
										maxControls,
										maxControlTextChars,
										maxControlTextNodes,
										maxNodes,
									}: {
										selectors: string[];
										actionMarkers: string[];
										negativeActionMarkers: string[];
										maxControls: number;
										maxControlTextChars: number;
										maxControlTextNodes: number;
										maxNodes: number;
									}) => {
										const interactiveSelector =
											"button, input[type='submit'], a[role='button'], [role='button']";

										function collectInteractiveElements(root: ParentNode): HTMLElement[] {
											const elements: HTMLElement[] = [];
											const roots: ParentNode[] = [root];
											let visitedNodes = 0;
											while (roots.length > 0) {
												const currentRoot = roots.pop();
												if (!currentRoot) break;
												const walker = document.createTreeWalker(
													currentRoot,
													NodeFilter.SHOW_ELEMENT,
												);
												while (walker.nextNode()) {
													visitedNodes += 1;
													if (visitedNodes > maxNodes) return elements;
													const node = walker.currentNode;
													if (!(node instanceof HTMLElement)) continue;
													if (node.matches(interactiveSelector)) {
														elements.push(node);
														if (elements.length >= maxControls) return elements;
													}
													if (node.shadowRoot) roots.push(node.shadowRoot);
												}
											}

											return elements;
										}

										function readControlText(control: HTMLElement): string {
											const walker = document.createTreeWalker(control, NodeFilter.SHOW_ALL);
											let text = "";
											let visitedNodes = 0;
											while (walker.nextNode()) {
												visitedNodes += 1;
												if (
													visitedNodes > maxControlTextNodes ||
													text.length >= maxControlTextChars
												) {
													break;
												}
												const node = walker.currentNode;
												if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue) continue;
												if (text.length > 0) text += " ";
												text += node.nodeValue.slice(0, maxControlTextChars - text.length);
											}
											return text;
										}

										function isVisible(element: HTMLElement): boolean {
											if (element.hidden) return false;
											if ("disabled" in element && element.disabled) return false;
											const style = window.getComputedStyle(element);
											return (
												style.display !== "none" &&
												style.visibility !== "hidden" &&
												style.pointerEvents !== "none"
											);
										}

										const buttons = collectInteractiveElements(document);
										const exactMatch = buttons.find(
											(button) =>
												isVisible(button) &&
												selectors.some((selector: string) => button.matches(selector)),
										);
										if (exactMatch) {
											exactMatch.click();
											return true;
										}

										const normalize = (value: string | null | undefined) =>
											(value ?? "")
												.slice(0, maxControlTextChars)
												.trim()
												.toLowerCase()
												.replace(/\s+/g, " ");
										const matchesAction = (...values: Array<string | null | undefined>) =>
											values.some((value) => {
												const normalized = normalize(value);
												if (
													negativeActionMarkers.some((marker: string) =>
														normalized.includes(marker),
													)
												) {
													return false;
												}
												return actionMarkers.some(
													(marker: string) =>
														normalized === marker || normalized.startsWith(`${marker} `),
												);
											});

										const textMatch = buttons.find((button) => {
											if (!isVisible(button)) return false;
											return matchesAction(
												readControlText(button),
												button.getAttribute("aria-label"),
												button.getAttribute("title"),
												button.getAttribute("value"),
											);
										});
										if (textMatch) {
											textMatch.click();
											return true;
										}

										return false;
									},
									{
										selectors: [...CONSENT_BUTTON_SELECTORS],
										actionMarkers: [...CONSENT_ACTION_MARKERS],
										negativeActionMarkers: [...CONSENT_NEGATIVE_ACTION_MARKERS],
										maxControls: MAX_CONSENT_CONTROLS,
										maxControlTextChars: MAX_CONSENT_CONTROL_TEXT_CHARS,
										maxControlTextNodes: MAX_CONSENT_CONTROL_TEXT_NODES,
										maxNodes: MAX_RENDERED_DOM_NODES,
									},
								),
						});
					} catch (error) {
						if (!isRecoverableBrowserError(error)) throw error;
						continue;
					}

					if (clicked) break;
				}
				if (!clicked && Date.now() < actionDeadline) {
					await sleep(CONSENT_POLL_INTERVAL_MS, undefined, signal ? { signal } : undefined);
				}
			}

			if (!clicked) {
				const visibleBodyText = await runPageOperationWithDeadline({
					page,
					timeoutMs: EVAL_TIMEOUT_MS,
					operationName: "Visible consent wall verification",
					...(signal ? { signal } : {}),
					run: (operationSignal) => readConsentBodyText(page, operationSignal, true),
				});
				if (!isConsentWallText(visibleBodyText)) {
					this.logger.debug(`Consent template found without a visible wall on ${url}`);
					return { detected: false, bypassed: false };
				}
				this.logger.info(`Consent wall did not become actionable on ${url}`);
				return { detected: true, bypassed: false };
			}

			this.logger.info(`Consent action clicked on ${url}, verifying dismissal...`);
			const cleared = await runPageOperationWithDeadline({
				page,
				timeoutMs: CLEAR_TIMEOUT_MS,
				operationName: "Consent wall dismissal",
				...(signal ? { signal } : {}),
				run: async (operationSignal) => {
					while (true) {
						const visibleBodyText = await readConsentBodyText(page, operationSignal, true);
						if (!isConsentWallText(visibleBodyText)) return true;
						await sleep(CONSENT_POLL_INTERVAL_MS, undefined, {
							signal: operationSignal,
						});
					}
				},
			});
			if (!cleared) {
				this.logger.info(`Consent wall remained visible after interaction on ${url}`);
			}
			return { detected: true, bypassed: cleared };
		} catch (error) {
			signal?.throwIfAborted();
			this.logger.info(`Consent bypass attempt failed: ${getErrorMessage(error)}`);
			return { detected: true, bypassed: false };
		}
	}

	async closePageSafely(page: Page): Promise<void> {
		try {
			await page.context().close();
		} catch (error_) {
			const message = getErrorMessage(error_);
			if (
				!message.includes("Target page, context or browser has been closed") &&
				!message.includes("Page closed")
			) {
				this.logger.debug(`Error closing page: ${message}`);
			}
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.enabled = false;
		this.closePromise ??= this.closeResources();
		return this.closePromise;
	}

	private async closeResources(): Promise<void> {
		const browser = this.browser;
		this.browser = null;
		try {
			if (browser) {
				await browser.close();
				this.logger.info("Playwright closed.");
			}
		} catch (err) {
			this.logger.warn(`Browser close failed: ${getErrorMessage(err)}`);
		}
	}
}
