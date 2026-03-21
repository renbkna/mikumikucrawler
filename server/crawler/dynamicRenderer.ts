import type { Session } from "crawlee";
import { BrowserPool, PlaywrightPlugin, SessionPool } from "crawlee";
import { chromium, type Page } from "playwright";
import { config } from "../config/env.js";
import type { Logger } from "../config/logging.js";
import {
	DYNAMIC_RENDERER_CONSTANTS,
	FETCH_HEADERS,
	SITE_COOKIES,
	SITE_SELECTORS,
} from "../constants.js";
import type { Resolver } from "../plugins/security.js";
import type {
	DynamicRenderAttempt,
	QueueItem,
	SanitizedCrawlOptions,
} from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";
import { logMemoryStatus } from "../utils/memoryMonitor.js";
import { withTimeout, withTimeoutFallback } from "../utils/timeout.js";
import {
	CONSENT_BUTTON_SELECTORS,
	isConsentWallText,
	requiresStrictConsentBypass,
} from "./consent.js";

interface InitializeResult {
	dynamicEnabled: boolean;
	fallbackLog?: string;
}

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

export class DynamicRenderer {
	private static readonly instances = new Set<DynamicRenderer>();
	private static handlersRegistered = false;

	private readonly options: SanitizedCrawlOptions;
	private readonly logger: Logger;
	private readonly resolver: Resolver;
	private browserPool: BrowserPool | null;
	private sessionPool: SessionPool | null;
	private enabled: boolean;

	private static registerGlobalHandlers(): void {
		if (DynamicRenderer.handlersRegistered) return;

		const exitHandler = (): void => {
			for (const instance of DynamicRenderer.instances) {
				if (instance.browserPool) {
					instance.browserPool.closeAllBrowsers().catch(() => {});
				}
			}
		};

		process.on("exit", exitHandler);
		DynamicRenderer.handlersRegistered = true;
	}

	constructor(
		options: SanitizedCrawlOptions,
		logger: Logger,
		resolver: Resolver,
	) {
		this.options = options;
		this.logger = logger;
		this.resolver = resolver;
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

	async initialize(): Promise<InitializeResult> {
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

		try {
			await this.launchBrowser();
			return { dynamicEnabled: this.isEnabled() };
		} catch (err) {
			this.disableDynamic(
				`Failed to launch Playwright: ${getErrorMessage(err)}`,
			);
			return {
				dynamicEnabled: false,
				fallbackLog:
					"Falling back to static crawling: dynamic renderer failed to start",
			};
		}
	}

	private async createSessionPool(): Promise<SessionPool> {
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
		return this.sessionPool;
	}

	async launchBrowser(): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		if (this.browserPool) {
			return;
		}

		this.logger.info("Launching Playwright (Chromium)...");
		await this.createSessionPool();

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

		const warmupPage = (await this.browserPool.newPage()) as Page;
		await warmupPage.close();
		this.logger.info("Playwright launched successfully");
	}

	private async configurePage(
		page: Page,
		url: string,
		session: Session,
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

		await page.route("**/*", async (route) => {
			const requestUrl = route.request().url();
			if (!shouldSkipSecurityValidation(requestUrl)) {
				try {
					const parsed = new URL(requestUrl);
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
						await route.abort();
						return;
					}
					await this.resolver.assertPublicHostname(parsed.hostname);
				} catch {
					await route.abort();
					return;
				}
			}

			if (
				["image", "stylesheet", "font", "media"].includes(
					route.request().resourceType(),
				)
			) {
				await route.abort();
				return;
			}

			await route.continue();
		});

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

	async render(item: QueueItem): Promise<DynamicRenderAttempt> {
		if (!this.isEnabled()) {
			return null;
		}

		if (!this.browserPool) {
			try {
				await this.launchBrowser();
			} catch (err) {
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
		const page = (await this.browserPool.newPage()) as Page;
		let navigationOccurred = false;
		const navigationHandler = () => {
			navigationOccurred = true;
		};

		try {
			await this.resolver.assertPublicHostname(new URL(item.url).hostname);
			await this.configurePage(page, item.url, session);

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
			const contentLength = Number.parseInt(
				headers["content-length"] || "0",
				10,
			);
			const lastModified = headers["last-modified"];
			const xRobotsTag = headers["x-robots-tag"] ?? null;

			if (statusCode >= 400) {
				session.retireOnBlockedStatusCodes(statusCode);
			}

			const consentBypass = await this.handleConsentModals(page, item.url);
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
					contentLength:
						contentLength || Buffer.byteLength(extracted.content, "utf8"),
					title: extracted.title,
					description: extracted.description || "",
					lastModified,
					xRobotsTag,
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
						(selectors) => {
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
									selectors.some((selector) => button.matches(selector)),
							);
							if (exactMatch) {
								exactMatch.click();
								return true;
							}

							const actionMarkers = [
								"accept all",
								"accept cookies",
								"i agree",
								"agree all",
								"accept",
								"agree",
								"allow",
								"allow all",
								"got it",
								"continue",
								"agree to the use of cookies",
								"alle akzeptieren",
								"alle annehmen",
								"akzeptieren",
								"zustimmen",
								"ich stimme zu",
								"zustimmen und fortfahren",
								"einverstanden",
							];
							const normalize = (value: string | null | undefined) =>
								(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
							const matchesAction = (
								...values: Array<string | null | undefined>
							) =>
								values.some((value) => {
									const normalized = normalize(value);
									return actionMarkers.some((marker) =>
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
						[...CONSENT_BUTTON_SELECTORS],
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
