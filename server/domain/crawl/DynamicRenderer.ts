import { setTimeout as sleep } from "node:timers/promises";
import { BrowserPool, PlaywrightPlugin } from "@crawlee/browser-pool";
import { type Session, SessionPool } from "@crawlee/core";
import {
	type BrowserContext,
	type BrowserContextOptions,
	chromium,
	type Page,
	type Route,
	type WebSocketRoute,
} from "playwright";
import type { CrawlOptions } from "../../../shared/contracts/index.js";
import { normalizeRobotsMatchHttpUrl } from "../../../shared/url.js";
import { resolveChromiumExecutable } from "../../config/browser.js";
import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import {
	DYNAMIC_RENDERER_CONSTANTS,
	FETCH_HEADERS,
	REQUEST_CONSTANTS,
	SITE_COOKIES,
	SITE_SELECTORS,
} from "../../constants.js";
import type { HttpClient } from "../../plugins/security.js";
import {
	isJsonContentType,
	isPdfContentType,
	isSupportedDocumentContentType,
} from "../../processors/contentTypes.js";
import { getErrorMessage } from "../../utils/helpers.js";
import { logMemoryStatus } from "../../utils/memoryMonitor.js";
import { disposeResponseBody, readLimitedResponseBody } from "../../utils/responseBody.js";
import { runWithTimeout, runWithTimeoutFallback } from "../../utils/timeout.js";
import type { QueueItem } from "./CrawlQueue.js";
import {
	CONSENT_ACTION_MARKERS,
	CONSENT_BUTTON_SELECTORS,
	CONSENT_NEGATIVE_ACTION_MARKERS,
	isConsentWallText,
	requiresStrictConsentBypass,
} from "./consent.js";

/**
 * Dynamic renderer contract:
 * - owns one crawl-scoped browser/session pool
 * - classifies dynamic fetches as success, consentBlocked, or static fallback
 * - never uses Playwright's native HTTP(S) network path; browser requests are
 *   fulfilled through the same pinned HTTP client used by static crawling
 */
interface InitializeResult {
	dynamicEnabled: boolean;
	fallbackLog?: string;
}

interface DynamicRenderResult {
	isDynamic: true;
	content: string;
	effectiveUrl: string;
	statusCode: number;
	contentType: string;
	contentLength: number;
	title: string;
	description: string;
	lastModified?: string;
	etag?: string | null;
	xRobotsTag?: string | null;
	retryAfter?: string | null;
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
}

interface DynamicTransportFailure {
	type: "transportFailure";
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

export function renderedContentByteLength(content: string): number {
	return new TextEncoder().encode(content).byteLength;
}

export interface DynamicRouteBudget {
	remainingRequests: number;
	remainingBytes: number;
}

export function createDynamicRouteBudget(
	maxRequests: number = DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MAX_REQUESTS_PER_PAGE,
	maxBytes: number = DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MAX_RESPONSE_BYTES_PER_PAGE,
): DynamicRouteBudget {
	return { remainingRequests: maxRequests, remainingBytes: maxBytes };
}

export type DynamicRouteResult =
	| { type: "fulfilled" }
	| { type: "continued" }
	| { type: "aborted"; reason: "static-representation" }
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

export function requiresStaticRepresentationFetch(contentType: string): boolean {
	return isJsonContentType(contentType) || isPdfContentType(contentType);
}

export function matchesOwnedSitePattern(url: string, pattern: string): boolean {
	try {
		const parsed = new URL(url);
		const separator = pattern.indexOf("/");
		const patternHostname = (
			separator === -1 ? pattern : pattern.slice(0, separator)
		).toLowerCase();
		const patternPath = separator === -1 ? "" : `/${pattern.slice(separator + 1)}`;
		const hostname = parsed.hostname.toLowerCase();
		return (
			(hostname === patternHostname || hostname.endsWith(`.${patternHostname}`)) &&
			(patternPath === "" || parsed.pathname.startsWith(patternPath))
		);
	} catch {
		return false;
	}
}

interface ReadinessSnapshot {
	bodyLength: number;
	hasPrimaryCandidate: boolean;
	title: string;
}

interface BrowserCookie {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Lax" | "None" | "Strict";
}

function isRecoverableBrowserError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.name === "TimeoutError") return true;

	const message = err.message;
	return (
		message.includes("Target page, context or browser has been closed") ||
		message.includes("Navigation failed because page crashed") ||
		message.includes("net::ERR_ABORTED") ||
		message.includes("Execution context was destroyed") ||
		message.includes("Frame was detached")
	);
}

async function readVisibleBodyText(page: Page, signal: AbortSignal): Promise<string> {
	while (true) {
		try {
			return await page.evaluate(() => document.body?.innerText ?? "");
		} catch (error) {
			if (!isRecoverableBrowserError(error)) throw error;
			await sleep(CONSENT_POLL_INTERVAL_MS, undefined, { signal });
		}
	}
}

function normalizeCookieSameSite(value: string | undefined): BrowserCookie["sameSite"] {
	if (value === "Lax" || value === "None" || value === "Strict") {
		return value;
	}
	return "Lax";
}

function shouldSkipSecurityValidation(url: string): boolean {
	return url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new Error("Dynamic renderer startup aborted");
}

export async function openBrowserPageWithRetry(
	createPage: () => Promise<Page>,
	onRetry: (error: unknown) => void,
	signal?: AbortSignal,
): Promise<Page> {
	try {
		return await createPage();
	} catch (error) {
		throwIfAborted(signal);
		if (!isRecoverableBrowserError(error)) throw error;
		onRetry(error);
		return createPage();
	}
}

export async function extractRenderedSnapshot(
	page: Page,
	signal?: AbortSignal,
): Promise<RenderedSnapshot | "tooLarge"> {
	return runWithTimeout({
		timeoutMs: 10_000,
		operationName: "Rendered document snapshot",
		...(signal ? { signal } : {}),
		run: () =>
			page.evaluate((maxBytes) => {
				const content = document.documentElement?.outerHTML ?? "";
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
			}, REQUEST_CONSTANTS.MAX_RESPONSE_BYTES),
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
	signal?: AbortSignal,
	allowLocalhostOnInitialRequest = false,
	budget = createDynamicRouteBudget(),
): Promise<DynamicRouteResult> {
	const request = route.request();
	const requestUrl = request.url();
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

	try {
		const response = await httpClient.fetch({
			url: requestUrl,
			headers: request.headers(),
			method,
			signal,
			...(allowLocalhostOnInitialRequest ? { allowLocalhostOnInitialRequest: true } : {}),
		});
		const contentType = response.headers.get("content-type") ?? "";
		if (request.resourceType() === "document") {
			if (requiresStaticRepresentationFetch(contentType)) {
				await disposeResponseBody(response);
				await route.abort();
				return { type: "aborted", reason: "static-representation" };
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
		let responseBudgetExceeded = false;
		const body = await readLimitedResponseBody(response, REQUEST_CONSTANTS.MAX_RESPONSE_BYTES, {
			tryConsume(bytes) {
				if (bytes > budget.remainingBytes) {
					responseBudgetExceeded = true;
					return false;
				}
				budget.remainingBytes -= bytes;
				return true;
			},
		});
		if (body.type === "tooLarge") {
			await route.abort();
			return {
				type: "aborted",
				reason: responseBudgetExceeded ? "response-budget" : "response-too-large",
			};
		}
		await route.fulfill({
			status: response.status,
			headers: createRouteFulfillHeaders(response.headers),
			body: Buffer.from(body.bytes),
		});
		return { type: "fulfilled" };
	} catch (error) {
		await route.abort();
		return {
			type: "aborted",
			reason: "transport-failure",
			message: getErrorMessage(error),
		};
	}
}

export function createDynamicBrowserContextOptions(): BrowserContextOptions {
	return { serviceWorkers: "block" };
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
	onDocumentResult?: (result: DynamicRouteResult) => void,
): Promise<void> {
	let seedCapabilityAvailable = seedUrl !== undefined;
	const budget = createDynamicRouteBudget();
	await context.route("**/*", async (route) => {
		const request = route.request();
		const useSeedCapability =
			seedCapabilityAvailable && request.resourceType() === "document" && request.url() === seedUrl;
		if (useSeedCapability) {
			seedCapabilityAvailable = false;
		}
		const result = await fulfillRouteWithPinnedHttpClient(
			route,
			httpClient,
			signal,
			useSeedCapability,
			budget,
		);
		if (request.resourceType() === "document") {
			onDocumentResult?.(result);
		}
	});
	await context.routeWebSocket("**/*", abortWebSocketRoute);
}

export class DynamicRenderer {
	private readonly options: CrawlOptions;
	private readonly logger: Logger;
	private readonly httpClient: HttpClient;
	private browserPool: BrowserPool | null;
	private sessionPool: SessionPool | null;
	private enabled: boolean;
	private closePromise: Promise<void> | null;

	constructor(options: CrawlOptions, logger: Logger, httpClient: HttpClient) {
		this.options = options;
		this.logger = logger;
		this.httpClient = httpClient;
		this.browserPool = null;
		this.sessionPool = null;
		this.enabled = options.dynamic;
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
		throwIfAborted(signal);
		if (!this.isEnabled()) {
			return { dynamicEnabled: false };
		}

		const memoryStatus = logMemoryStatus(this.logger);

		if (memoryStatus.isLowMemory) {
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
			throwIfAborted(signal);
			return { dynamicEnabled: this.isEnabled() };
		} catch (err) {
			throwIfAborted(signal);
			this.disableDynamic(`Failed to launch Playwright: ${getErrorMessage(err)}`);
			return {
				dynamicEnabled: false,
				fallbackLog: "Falling back to static crawling: dynamic renderer failed to start",
			};
		} finally {
			signal?.removeEventListener("abort", closeOnAbort);
		}
	}

	private async createSessionPool(signal?: AbortSignal): Promise<SessionPool> {
		throwIfAborted(signal);
		if (this.sessionPool) {
			return this.sessionPool;
		}

		this.sessionPool = await SessionPool.open({
			maxPoolSize: Math.max(this.options.maxConcurrentRequests * 4, 8),
			sessionOptions: {
				maxAgeSecs: 30 * 60,
				maxUsageCount: 20,
			},
			persistenceOptions: { enable: false },
		});
		throwIfAborted(signal);
		return this.sessionPool;
	}

	async launchBrowser(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (!this.isEnabled()) {
			return;
		}

		if (this.browserPool) {
			return;
		}

		const closeOnAbort = () => {
			void this.close();
		};
		signal?.addEventListener("abort", closeOnAbort, { once: true });
		try {
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
			await this.createSessionPool(signal);
			throwIfAborted(signal);

			const executablePath =
				browserExecutable.source === "configured" || browserExecutable.source === "system"
					? browserExecutable.executablePath
					: undefined;

			this.browserPool = new BrowserPool({
				browserPlugins: [
					new PlaywrightPlugin(chromium, {
						useIncognitoPages: true,
						launchOptions: {
							headless: true,
							args: [
								"--no-sandbox",
								"--disable-setuid-sandbox",
								"--disable-dev-shm-usage",
								"--disable-gpu",
								"--disable-blink-features=AutomationControlled",
								"--disable-extensions",
								"--disable-background-networking",
							],
							...(executablePath !== undefined ? { executablePath } : {}),
						},
					}),
				],
				maxOpenPagesPerBrowser: Math.max(this.options.maxConcurrentRequests, 1),
				retireBrowserAfterPageCount: config.isRender
					? DYNAMIC_RENDERER_CONSTANTS.RECYCLE_THRESHOLD.RENDER_ENV
					: DYNAMIC_RENDERER_CONSTANTS.RECYCLE_THRESHOLD.DEFAULT,
				closeInactiveBrowserAfterSecs: 30,
				operationTimeoutSecs: Math.ceil(
					DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.COMPLEX_NAVIGATION / 1000,
				),
			});
			throwIfAborted(signal);

			const warmupPage = await this.openPage(signal);
			try {
				throwIfAborted(signal);
			} finally {
				await this.closePageSafely(warmupPage);
			}
			throwIfAborted(signal);
			this.logger.info("Playwright launched successfully");
		} finally {
			signal?.removeEventListener("abort", closeOnAbort);
		}
	}

	private async openPage(signal?: AbortSignal): Promise<Page> {
		const browserPool = this.browserPool;
		if (!browserPool) {
			throw new Error("Cannot open a page before the browser pool is initialized");
		}

		const createPage = () =>
			browserPool.newPage({
				pageOptions: createDynamicBrowserContextOptions(),
			} as never) as Promise<Page>;

		return openBrowserPageWithRetry(
			createPage,
			(error) => {
				this.logger.debug(
					`Browser page acquisition failed; retrying with a fresh controller: ${getErrorMessage(error)}`,
				);
			},
			signal,
		);
	}

	private async configurePage(
		page: Page,
		item: QueueItem,
		session: Session,
		signal?: AbortSignal,
		onDocumentResult?: (result: DynamicRouteResult) => void,
	): Promise<void> {
		await page.setViewportSize(DYNAMIC_RENDERER_CONSTANTS.VIEWPORT);
		page.setDefaultTimeout(DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.STANDARD_NAVIGATION);
		page.setDefaultNavigationTimeout(DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.STANDARD_NAVIGATION);
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
		);

		page.on("dialog", (dialog) => {
			dialog.dismiss().catch((err) => {
				this.logger.debug(`Failed to dismiss dialog: ${getErrorMessage(err)}`);
			});
		});

		await this.setCookiesForPage(page, item.url, session);
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

	async render(item: QueueItem, signal?: AbortSignal): Promise<DynamicRenderAttempt> {
		throwIfAborted(signal);
		if (!this.isEnabled()) {
			return { type: "staticFallback", reason: "renderer-unavailable" };
		}

		if (!this.browserPool) {
			try {
				await this.launchBrowser(signal);
			} catch (err) {
				throwIfAborted(signal);
				this.disableDynamic(`Failed to relaunch Playwright: ${getErrorMessage(err)}`);
				return { type: "staticFallback", reason: "renderer-unavailable" };
			}
		}

		if (!this.browserPool || !this.sessionPool) {
			return { type: "staticFallback", reason: "renderer-unavailable" };
		}

		const session = await this.sessionPool.getSession();
		const page = await this.openPage(signal);
		let abortCleanup: Promise<void> | undefined;
		let documentRouteResult: DynamicRouteResult | undefined;
		const closeOnAbort = () => {
			abortCleanup ??= this.closePageSafely(page);
		};
		signal?.addEventListener("abort", closeOnAbort, { once: true });

		try {
			throwIfAborted(signal);
			await this.configurePage(page, item, session, signal, (result) => {
				documentRouteResult = result;
			});
			throwIfAborted(signal);

			const isComplex = DYNAMIC_RENDERER_CONSTANTS.COMPLEX_JS_SITES.some((site) =>
				matchesOwnedSitePattern(item.url, site),
			);
			const navigationTimeout = isComplex
				? DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.COMPLEX_NAVIGATION
				: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.STANDARD_NAVIGATION;

			const response = await runWithTimeout({
				timeoutMs: navigationTimeout,
				operationName: `Dynamic navigation for ${item.url}`,
				...(signal ? { signal } : {}),
				run: () =>
					page.goto(item.url, {
						waitUntil: "domcontentloaded",
						timeout: navigationTimeout,
					}),
			});
			throwIfAborted(signal);

			const statusCode = response?.status() ?? 0;
			const headers = response?.headers() ?? {};
			const contentType = headers["content-type"] || "";
			const lastModified = headers["last-modified"];
			const etag = headers.etag;
			const xRobotsTag = headers["x-robots-tag"] ?? null;
			const retryAfter = headers["retry-after"] ?? null;
			if (requiresStaticRepresentationFetch(contentType)) {
				this.logger.debug(`Non-HTML response for ${item.url}; using bounded static acquisition`);
				session.markGood();
				return { type: "staticFallback", reason: "non-html" };
			}

			if (statusCode >= 400) {
				session.retireOnBlockedStatusCodes(statusCode);
			}

			const consentBypass = await this.handleConsentModals(page, item.url, signal);
			throwIfAborted(signal);
			if (
				consentBypass.detected &&
				!consentBypass.bypassed &&
				requiresStrictConsentBypass(item.url)
			) {
				session.retire();
				return {
					type: "consentBlocked",
					message: `Consent wall could not be bypassed for ${item.url}`,
					statusCode: statusCode >= 400 ? statusCode : 403,
				};
			}

			if (isComplex) {
				await this.waitForComplexContent(page, item.url, signal);
			}
			throwIfAborted(signal);

			const extracted = await this.safeExtractContent(page, signal);
			throwIfAborted(signal);
			if (!extracted || extracted === "tooLarge") {
				session.markBad();
				return extracted === "tooLarge"
					? { type: "tooLarge" }
					: { type: "staticFallback", reason: "content-unavailable" };
			}

			const normalizedEffectiveUrl = normalizeRobotsMatchHttpUrl(extracted.effectiveUrl);
			if ("error" in normalizedEffectiveUrl) {
				session.markBad();
				return { type: "staticFallback", reason: "content-unavailable" };
			}

			await this.persistSessionCookies(session, page, item.url);
			throwIfAborted(signal);
			session.markGood();

			return {
				type: "success",
				result: {
					isDynamic: true,
					content: extracted.content,
					effectiveUrl: normalizedEffectiveUrl.url,
					statusCode,
					contentType,
					contentLength: extracted.contentLength,
					title: extracted.title,
					description: extracted.description || "",
					...(lastModified !== undefined ? { lastModified } : {}),
					...(etag !== undefined ? { etag } : {}),
					xRobotsTag,
					retryAfter,
				},
			};
		} catch (err) {
			session.markBad();
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new Error("Dynamic render aborted");
			}

			if (documentRouteResult?.type === "aborted") {
				if (documentRouteResult.reason === "static-representation") {
					return { type: "staticFallback", reason: "non-html" };
				}
				if (documentRouteResult.reason === "unsupported-content") {
					return {
						type: "unsupported",
						contentType: documentRouteResult.contentType,
						statusCode: documentRouteResult.statusCode,
					};
				}
				if (
					documentRouteResult.reason === "response-budget" ||
					documentRouteResult.reason === "response-too-large"
				) {
					return { type: "tooLarge" };
				}
				if (documentRouteResult.reason === "transport-failure") {
					return {
						type: "transportFailure",
						message: documentRouteResult.message ?? getErrorMessage(err),
					};
				}
			}

			if (isRecoverableBrowserError(err)) {
				this.logger.debug(
					`Recoverable browser error for ${item.url}, falling back to static crawling: ${getErrorMessage(err)}`,
				);
				return { type: "staticFallback", reason: "content-unavailable" };
			}

			this.logger.warn(
				`Unexpected error during dynamic rendering of ${item.url}: ${getErrorMessage(err)}`,
			);
			return { type: "staticFallback", reason: "content-unavailable" };
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
			const bodyText = await runWithTimeoutFallback({
				timeoutMs: EVAL_TIMEOUT_MS,
				operationName: "Consent body text extraction",
				fallback: "",
				...(signal ? { signal } : {}),
				run: () => page.evaluate(() => document.body?.textContent ?? ""),
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
						clicked = await runWithTimeoutFallback({
							timeoutMs: Math.max(1, actionDeadline - Date.now()),
							operationName: "Consent button evaluation",
							fallback: false,
							...(signal ? { signal } : {}),
							run: () =>
								frame.evaluate(
									({
										selectors,
										actionMarkers,
										negativeActionMarkers,
									}: {
										selectors: string[];
										actionMarkers: string[];
										negativeActionMarkers: string[];
									}) => {
										const interactiveSelector =
											"button, input[type='submit'], a[role='button'], [role='button']";

										function collectInteractiveElements(root: ParentNode): HTMLElement[] {
											const elements = Array.from(
												root.querySelectorAll(interactiveSelector),
											) as HTMLElement[];
											const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
											const shadowElements: HTMLElement[] = [];

											while (walker.nextNode()) {
												const node = walker.currentNode;
												if (!(node instanceof Element)) continue;
												if (node.shadowRoot) {
													shadowElements.push(...collectInteractiveElements(node.shadowRoot));
												}
											}

											return [...elements, ...shadowElements];
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
											(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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
												button.textContent,
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
				const visibleBodyText = await runWithTimeoutFallback({
					timeoutMs: EVAL_TIMEOUT_MS,
					operationName: "Visible consent wall verification",
					fallback: null,
					...(signal ? { signal } : {}),
					run: (operationSignal) => readVisibleBodyText(page, operationSignal),
				});
				if (visibleBodyText !== null && !isConsentWallText(visibleBodyText)) {
					this.logger.debug(`Consent template found without a visible wall on ${url}`);
					return { detected: false, bypassed: false };
				}
				this.logger.info(`Consent wall did not become actionable on ${url}`);
				return { detected: true, bypassed: false };
			}

			this.logger.info(`Consent action clicked on ${url}, verifying dismissal...`);
			const cleared = await runWithTimeoutFallback({
				timeoutMs: CLEAR_TIMEOUT_MS,
				operationName: "Consent wall dismissal",
				fallback: false,
				...(signal ? { signal } : {}),
				run: async (operationSignal) => {
					while (true) {
						const visibleBodyText = await readVisibleBodyText(page, operationSignal);
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
			throwIfAborted(signal);
			this.logger.info(`Consent bypass attempt failed: ${getErrorMessage(error)}`);
			return { detected: true, bypassed: false };
		}
	}

	async waitForComplexContent(page: Page, url: string, signal?: AbortSignal): Promise<void> {
		const additionalWaitTime = DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.ADDITIONAL_WAIT;
		const selectorToWait = Object.entries(SITE_SELECTORS).find(([pattern]) =>
			matchesOwnedSitePattern(url, pattern),
		)?.[1];

		let selectorMatched = false;
		if (selectorToWait) {
			try {
				await runWithTimeout({
					timeoutMs: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.SELECTOR_WAIT,
					operationName: `Dynamic selector wait for ${url}`,
					...(signal ? { signal } : {}),
					run: () =>
						page.waitForSelector(selectorToWait, {
							timeout: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.SELECTOR_WAIT,
						}),
				});
				selectorMatched = true;
				this.logger.debug(`Waited for selector: ${selectorToWait} on ${url}`);
			} catch (error_) {
				throwIfAborted(signal);
				this.logger.debug(`Preferred selector not found for ${url}: ${getErrorMessage(error_)}`);
			}
		}

		await sleep(additionalWaitTime, undefined, signal ? { signal } : undefined);

		const readiness = await runWithTimeoutFallback<ReadinessSnapshot>({
			timeoutMs: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.SELECTOR_WAIT,
			operationName: "Complex content readiness evaluation",
			fallback: {
				bodyLength: 0,
				hasPrimaryCandidate: false,
				title: "",
			},
			...(signal ? { signal } : {}),
			run: () =>
				page.evaluate(() => {
					const bodyText = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
					const hasPrimaryCandidate = Boolean(
						document.querySelector(
							"main, article, [role='main'], shreddit-post, [data-testid='post-container'], ytd-watch-flexy, ytd-page-manager",
						),
					);
					return {
						bodyLength: bodyText.length,
						hasPrimaryCandidate,
						title: document.title || "",
					};
				}),
		});

		if (
			!selectorMatched &&
			!readiness.hasPrimaryCandidate &&
			readiness.bodyLength < 300 &&
			readiness.title.trim().length === 0
		) {
			this.logger.warn(
				`Complex site readiness weak for ${url}: selector missing and content not yet meaningful`,
			);
		}
	}

	private async setCookiesForPage(page: Page, url: string, session: Session): Promise<void> {
		try {
			const sessionCookies = session.getCookies(url).map((cookie) => ({
				name: cookie.name,
				value: cookie.value,
				domain: cookie.domain,
				path: cookie.path ?? "/",
				expires: cookie.expires,
				httpOnly: cookie.httpOnly,
				secure: cookie.secure,
				sameSite: normalizeCookieSameSite(cookie.sameSite),
			}));

			const siteCookies = Object.entries(SITE_COOKIES).find(([pattern]) =>
				matchesOwnedSitePattern(url, pattern),
			)?.[1];

			let configuredCookies: BrowserCookie[] = [];
			if (siteCookies?.length) {
				const { parse } = await import("tldts");
				const parsed = parse(url);
				if (parsed.domain) {
					configuredCookies = siteCookies.map((cookie) => ({
						name: cookie.name,
						value: cookie.value,
						domain: `.${parsed.domain}`,
						path: "/",
						httpOnly: false,
						secure: true,
						sameSite: "Lax",
					}));
				}
			}

			const cookiesToSet = [...configuredCookies, ...sessionCookies];
			if (cookiesToSet.length === 0) {
				return;
			}

			await page.context().addCookies(cookiesToSet);
		} catch (error_) {
			this.logger.debug(`Cookie setting failed: ${getErrorMessage(error_)}`);
		}
	}

	private async persistSessionCookies(session: Session, page: Page, url: string): Promise<void> {
		try {
			const cookies = await page.context().cookies([url]);
			session.setCookies(
				cookies.map((cookie) => ({
					name: cookie.name,
					value: cookie.value,
					domain: cookie.domain,
					path: cookie.path,
					expires: cookie.expires,
					httpOnly: cookie.httpOnly,
					secure: cookie.secure,
					sameSite: cookie.sameSite,
				})),
				url,
			);
		} catch (error_) {
			this.logger.debug(`Session cookie persistence failed: ${getErrorMessage(error_)}`);
		}
	}

	async closePageSafely(page: Page): Promise<void> {
		try {
			if (!page.isClosed()) {
				await page.close();
			}
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
		this.closePromise ??= this.closeResources();
		return this.closePromise;
	}

	private async closeResources(): Promise<void> {
		try {
			if (this.browserPool) {
				await this.browserPool.closeAllBrowsers();
				this.logger.info("Playwright closed.");
			}
		} catch (err) {
			this.logger.warn(`Browser close failed: ${getErrorMessage(err)}`);
		} finally {
			this.browserPool = null;
		}

		if (this.sessionPool) {
			await this.sessionPool.teardown().catch(() => {});
			this.sessionPool = null;
		}
	}
}
