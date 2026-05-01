import type { Session } from "crawlee";
import { BrowserPool, PlaywrightPlugin, SessionPool } from "crawlee";
import {
	type BrowserContext,
	type BrowserContextOptions,
	chromium,
	type Page,
	type Route,
	type WebSocketRoute,
} from "playwright";
import type { CrawlOptions } from "../../../shared/contracts/crawl.js";
import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import {
	DYNAMIC_RENDERER_CONSTANTS,
	FETCH_HEADERS,
	SITE_COOKIES,
	SITE_SELECTORS,
} from "../../constants.js";
import type { HttpClient } from "../../plugins/security.js";
import { getErrorMessage } from "../../utils/helpers.js";
import { logMemoryStatus } from "../../utils/memoryMonitor.js";
import { withTimeout, withTimeoutFallback } from "../../utils/timeout.js";
import type { QueueItem } from "./CrawlQueue.js";
import {
	CONSENT_ACTION_MARKERS,
	CONSENT_BUTTON_SELECTORS,
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

type DynamicRenderAttempt =
	| DynamicRenderSuccess
	| DynamicRenderConsentBlocked
	| null;

interface ConsentBypassResult {
	detected: boolean;
	clicked: boolean;
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
		message.includes("Execution context was destroyed")
	);
}

function normalizeCookieSameSite(
	value: string | undefined,
): BrowserCookie["sameSite"] {
	if (value === "Lax" || value === "None" || value === "Strict") {
		return value;
	}
	return "Lax";
}

function shouldSkipSecurityValidation(url: string): boolean {
	return (
		url.startsWith("data:") ||
		url.startsWith("blob:") ||
		url.startsWith("about:")
	);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new Error("Dynamic renderer startup aborted");
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
): Promise<void> {
	const request = route.request();
	const requestUrl = request.url();
	if (shouldSkipSecurityValidation(requestUrl)) {
		await route.continue();
		return;
	}

	const parsed = new URL(requestUrl);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		await route.abort();
		return;
	}

	if (
		["image", "stylesheet", "font", "media"].includes(request.resourceType())
	) {
		await route.abort();
		return;
	}

	try {
		const method = request.method();
		const postData = request.postDataBuffer() ?? undefined;
		const response = await httpClient.fetch({
			url: requestUrl,
			headers: request.headers(),
			method,
			body:
				postData && method !== "GET" && method !== "HEAD"
					? new Uint8Array(postData)
					: undefined,
			signal,
		});
		const body = Buffer.from(await response.arrayBuffer());
		await route.fulfill({
			status: response.status,
			headers: createRouteFulfillHeaders(response.headers),
			body,
		});
	} catch {
		await route.abort();
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
): Promise<void> {
	await context.route("**/*", async (route) => {
		await fulfillRouteWithPinnedHttpClient(route, httpClient, signal);
	});
	await context.routeWebSocket("**/*", abortWebSocketRoute);
}

export class DynamicRenderer {
	private static readonly instances = new Set<DynamicRenderer>();
	private static handlersRegistered = false;

	private readonly options: CrawlOptions;
	private readonly logger: Logger;
	private readonly httpClient: HttpClient;
	private browserPool: BrowserPool | null;
	private sessionPool: SessionPool | null;
	private enabled: boolean;

	private static registerGlobalHandlers(): void {
		if (DynamicRenderer.handlersRegistered) return;

		const closeOpenBrowsers = (): void => {
			for (const instance of DynamicRenderer.instances) {
				if (instance.browserPool) {
					instance.browserPool.closeAllBrowsers().catch(() => {});
				}
			}
		};

		process.on("beforeExit", closeOpenBrowsers);
		process.on("exit", closeOpenBrowsers);
		DynamicRenderer.handlersRegistered = true;
	}

	constructor(options: CrawlOptions, logger: Logger, httpClient: HttpClient) {
		this.options = options;
		this.logger = logger;
		this.httpClient = httpClient;
		this.browserPool = null;
		this.sessionPool = null;
		this.enabled = options.dynamic;

		DynamicRenderer.instances.add(this);
		DynamicRenderer.registerGlobalHandlers();
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
		const constrainedEnvironment =
			memoryStatus.isLowMemory ||
			(config.isRender && memoryStatus.heapUsed > 50);

		if (constrainedEnvironment) {
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
			this.disableDynamic(
				`Failed to launch Playwright: ${getErrorMessage(err)}`,
			);
			return {
				dynamicEnabled: false,
				fallbackLog:
					"Falling back to static crawling: dynamic renderer failed to start",
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

		this.logger.info("Launching Playwright (Chromium)...");
		await this.createSessionPool(signal);
		throwIfAborted(signal);

		const executablePath = config.browser.executablePath;

		this.browserPool = new BrowserPool({
			browserPlugins: [
				new PlaywrightPlugin(chromium, {
					useIncognitoPages: true,
					launchOptions: {
						headless: true,
						executablePath,
						args: [
							"--no-sandbox",
							"--disable-setuid-sandbox",
							"--disable-dev-shm-usage",
							"--disable-gpu",
							"--disable-blink-features=AutomationControlled",
							"--disable-extensions",
							"--disable-background-networking",
						],
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

		const warmupPage = (await this.browserPool.newPage({
			pageOptions: createDynamicBrowserContextOptions(),
		} as never)) as Page;
		throwIfAborted(signal);
		await warmupPage.close();
		throwIfAborted(signal);
		this.logger.info("Playwright launched successfully");
	}

	private async configurePage(
		page: Page,
		url: string,
		session: Session,
		signal?: AbortSignal,
	): Promise<void> {
		await page.setViewportSize(DYNAMIC_RENDERER_CONSTANTS.VIEWPORT);
		page.setDefaultTimeout(
			DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.STANDARD_NAVIGATION,
		);
		page.setDefaultNavigationTimeout(
			DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.STANDARD_NAVIGATION,
		);
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
		);

		page.on("dialog", (dialog) => {
			dialog.dismiss().catch((err) => {
				this.logger.debug(`Failed to dismiss dialog: ${getErrorMessage(err)}`);
			});
		});

		await this.setCookiesForPage(page, url, session);
	}

	private async safeExtractContent(
		page: Page,
	): Promise<{ content: string; title: string; description: string } | null> {
		const EXTRACTION_TIMEOUT_MS = 10_000;

		try {
			if (page.isClosed()) {
				return null;
			}

			const content = await withTimeout(
				page.content(),
				EXTRACTION_TIMEOUT_MS,
				"Content extraction",
			);

			const metadata = await withTimeout(
				page.evaluate(() => {
					const title = document.title || "";
					const description =
						document
							.querySelector('meta[name="description"]')
							?.getAttribute("content") || "";
					return { title, description };
				}),
				EXTRACTION_TIMEOUT_MS,
				"Metadata extraction",
			);

			return {
				content,
				title: metadata.title,
				description: metadata.description,
			};
		} catch (err) {
			if (isRecoverableBrowserError(err)) {
				this.logger.debug(
					`Content extraction failed for page: ${getErrorMessage(err)}`,
				);
				return null;
			}

			throw err;
		}
	}

	async render(
		item: QueueItem,
		signal?: AbortSignal,
	): Promise<DynamicRenderAttempt> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("Dynamic render aborted");
		}
		if (!this.isEnabled()) {
			return null;
		}

		if (!this.browserPool) {
			try {
				await this.launchBrowser(signal);
			} catch (err) {
				throwIfAborted(signal);
				this.disableDynamic(
					`Failed to relaunch Playwright: ${getErrorMessage(err)}`,
				);
				return null;
			}
		}

		if (!this.browserPool || !this.sessionPool) {
			return null;
		}

		const session = await this.sessionPool.getSession();
		const page = (await this.browserPool.newPage({
			pageOptions: createDynamicBrowserContextOptions(),
		} as never)) as Page;
		let navigationOccurred = false;
		const navigationHandler = () => {
			navigationOccurred = true;
		};

		try {
			await this.configurePage(page, item.url, session, signal);
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new Error("Dynamic render aborted");
			}

			const isComplex = DYNAMIC_RENDERER_CONSTANTS.COMPLEX_JS_SITES.some(
				(site) => item.url.includes(site),
			);
			const navigationTimeout = isComplex
				? DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.COMPLEX_NAVIGATION
				: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.STANDARD_NAVIGATION;

			const response = await page.goto(item.url, {
				waitUntil: "domcontentloaded",
				timeout: navigationTimeout,
			});

			const statusCode = response?.status() ?? 0;
			const headers = response?.headers() ?? {};
			const contentType = headers["content-type"] || "";
			const lastModified = headers["last-modified"];
			const etag = headers.etag;
			const xRobotsTag = headers["x-robots-tag"] ?? null;
			const retryAfter = headers["retry-after"] ?? null;

			if (statusCode >= 400) {
				session.retireOnBlockedStatusCodes(statusCode);
			}

			const consentBypass = await this.handleConsentModals(page, item.url);
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new Error("Dynamic render aborted");
			}
			if (
				consentBypass.detected &&
				!consentBypass.clicked &&
				requiresStrictConsentBypass(item.url)
			) {
				session.retire();
				page.off("framenavigated", navigationHandler);
				await this.closePageSafely(page);
				return {
					type: "consentBlocked",
					message: `Consent wall could not be bypassed for ${item.url}`,
					statusCode: statusCode >= 400 ? statusCode : 403,
				};
			}

			page.on("framenavigated", navigationHandler);

			if (isComplex) {
				await this.waitForComplexContent(page, item.url);
			}

			if (consentBypass.clicked) {
				navigationOccurred = false;
			}

			if (navigationOccurred) {
				this.logger.debug(
					`Unexpected navigation during rendering of ${item.url}, falling back to static`,
				);
				page.off("framenavigated", navigationHandler);
				session.markBad();
				await this.closePageSafely(page);
				return null;
			}

			const extracted = await this.safeExtractContent(page);
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new Error("Dynamic render aborted");
			}
			if (!extracted || navigationOccurred) {
				page.off("framenavigated", navigationHandler);
				session.markBad();
				await this.closePageSafely(page);
				return null;
			}

			await this.persistSessionCookies(session, page, item.url);
			session.markGood();

			page.off("framenavigated", navigationHandler);
			await page.close();

			return {
				type: "success",
				result: {
					isDynamic: true,
					content: extracted.content,
					statusCode,
					contentType,
					contentLength: Buffer.byteLength(extracted.content, "utf8"),
					title: extracted.title,
					description: extracted.description || "",
					lastModified,
					etag,
					xRobotsTag,
					retryAfter,
				},
			};
		} catch (err) {
			page.off("framenavigated", navigationHandler);
			session.markBad();
			await this.closePageSafely(page);

			if (isRecoverableBrowserError(err)) {
				this.logger.debug(
					`Recoverable browser error for ${item.url}, falling back to static crawling: ${getErrorMessage(err)}`,
				);
				return null;
			}

			this.logger.warn(
				`Unexpected error during dynamic rendering of ${item.url}: ${getErrorMessage(err)}`,
			);
			return null;
		}
	}

	async handleConsentModals(
		page: Page,
		url: string,
	): Promise<ConsentBypassResult> {
		const EVAL_TIMEOUT_MS = DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.CONSENT_EVAL;
		const NAV_TIMEOUT_MS =
			DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.CONSENT_NAVIGATION;

		try {
			const bodyText = await withTimeoutFallback(
				page.evaluate(() => document.body?.textContent ?? ""),
				EVAL_TIMEOUT_MS,
				"",
			);

			if (!isConsentWallText(bodyText)) {
				return { detected: false, clicked: false };
			}

			this.logger.info(
				`Consent wall detected on ${url}. Attempting to bypass...`,
			);

			let clicked = false;
			for (const frame of page.frames()) {
				clicked = await withTimeoutFallback(
					frame.evaluate(
						({
							selectors,
							actionMarkers,
						}: {
							selectors: string[];
							actionMarkers: string[];
						}) => {
							const interactiveSelector =
								"button, input[type='submit'], a[role='button'], [role='button']";

							function collectInteractiveElements(
								root: ParentNode,
							): HTMLElement[] {
								const elements = Array.from(
									root.querySelectorAll(interactiveSelector),
								) as HTMLElement[];
								const walker = document.createTreeWalker(
									root,
									NodeFilter.SHOW_ELEMENT,
								);
								const shadowElements: HTMLElement[] = [];

								while (walker.nextNode()) {
									const node = walker.currentNode;
									if (!(node instanceof Element)) continue;
									if (node.shadowRoot) {
										shadowElements.push(
											...collectInteractiveElements(node.shadowRoot),
										);
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
									selectors.some((selector: string) =>
										button.matches(selector),
									),
							);
							if (exactMatch) {
								exactMatch.click();
								return true;
							}

							const normalize = (value: string | null | undefined) =>
								(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
							const matchesAction = (
								...values: Array<string | null | undefined>
							) =>
								values.some((value) => {
									const normalized = normalize(value);
									return actionMarkers.some((marker: string) =>
										normalized.includes(marker),
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
						},
					),
					EVAL_TIMEOUT_MS,
					false,
				);

				if (clicked) break;
			}

			if (!clicked) {
				this.logger.info(`No consent button found on ${url}`);
				return { detected: true, clicked: false };
			}

			this.logger.info(
				`Consent bypass clicked on ${url}, waiting for navigation...`,
			);

			try {
				await withTimeoutFallback(
					page.waitForLoadState("domcontentloaded", {
						timeout: NAV_TIMEOUT_MS,
					}),
					NAV_TIMEOUT_MS,
					null,
				);
			} catch {
				this.logger.debug(
					`Consent navigation wait completed/timed out for ${url}`,
				);
			}

			await Bun.sleep(1000);
			return { detected: true, clicked: true };
		} catch (error) {
			this.logger.info(
				`Consent bypass attempt failed: ${getErrorMessage(error)}`,
			);
			return { detected: true, clicked: false };
		}
	}

	async waitForComplexContent(page: Page, url: string): Promise<void> {
		const additionalWaitTime =
			DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.ADDITIONAL_WAIT;
		const selectorToWait = Object.entries(SITE_SELECTORS).find(([pattern]) =>
			url.includes(pattern),
		)?.[1];

		let selectorMatched = false;
		if (selectorToWait) {
			try {
				await page.waitForSelector(selectorToWait, {
					timeout: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.SELECTOR_WAIT,
				});
				selectorMatched = true;
				this.logger.debug(`Waited for selector: ${selectorToWait} on ${url}`);
			} catch (error_) {
				this.logger.debug(
					`Preferred selector not found for ${url}: ${getErrorMessage(error_)}`,
				);
			}
		}

		const readiness = await withTimeoutFallback<ReadinessSnapshot>(
			page.evaluate(() => {
				const bodyText = (document.body?.innerText ?? "")
					.replace(/\s+/g, " ")
					.trim();
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
			DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.SELECTOR_WAIT,
			{
				bodyLength: 0,
				hasPrimaryCandidate: false,
				title: "",
			},
		);

		if (
			!selectorMatched &&
			!readiness.hasPrimaryCandidate &&
			readiness.bodyLength < 300
		) {
			this.logger.warn(
				`Complex site readiness weak for ${url}: selector missing and content not yet meaningful`,
			);
		}

		await Bun.sleep(additionalWaitTime);
	}

	private async setCookiesForPage(
		page: Page,
		url: string,
		session: Session,
	): Promise<void> {
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
				url.includes(pattern),
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

	private async persistSessionCookies(
		session: Session,
		page: Page,
		url: string,
	): Promise<void> {
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
			this.logger.debug(
				`Session cookie persistence failed: ${getErrorMessage(error_)}`,
			);
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
		DynamicRenderer.instances.delete(this);

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
