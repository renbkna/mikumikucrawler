// NOTE: puppeteer is imported dynamically inside launchBrowser() so that merely
// importing this module (e.g. in tests) does NOT spin up Chromium.
import type { Browser, Page } from "puppeteer";
import { config } from "../config/env.js";
import type { Logger } from "../config/logging.js";
import {
	DYNAMIC_RENDERER_CONSTANTS,
	FETCH_HEADERS,
	SITE_COOKIES,
	SITE_SELECTORS,
} from "../constants.js";
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

/**
 * Handles dynamic page rendering using Puppeteer to support SPA and JS-heavy sites.
 *
 * Uses Ghostery's adblocker to block:
 * - Ads (reduces page weight)
 * - Cookie consent banners (EasyList Cookie List)
 * - Tracking scripts
 *
 * This is more robust than manual consent handling and is maintained by the community.
 */
/**
 * Checks if an error is a recoverable Puppeteer error that should trigger static fallback.
 * Uses error.name (Puppeteer's TimeoutError, ProtocolError) as the primary check,
 * with message matching only for edge cases that don't use typed error classes.
 */
function isRecoverableBrowserError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	// Puppeteer typed errors: TimeoutError, ProtocolError (includes TargetCloseError)
	if (err.name === "TimeoutError" || err.name === "ProtocolError") return true;
	// Fallback for frame/context errors not covered by typed classes
	const msg = err.message;
	return (
		msg.includes("detached Frame") ||
		msg.includes("Execution context was destroyed")
	);
}

export class DynamicRenderer {
	private static readonly instances = new Set<DynamicRenderer>();
	private static handlersRegistered = false;
	private static blockerPromise: Promise<InstanceType<
		typeof import("@ghostery/adblocker-puppeteer").PuppeteerBlocker
	> | null> | null = null;

	private readonly options: SanitizedCrawlOptions;
	private readonly logger: Logger;
	private browser: Browser | null;
	private browserPid: number | null;
	private pageCount: number;
	private enabled: boolean;

	/**
	 * Lazily initializes the adblocker with EasyList filter lists.
	 * Shared across all instances to avoid re-downloading filter lists.
	 */
	private static async getBlocker(): Promise<InstanceType<
		typeof import("@ghostery/adblocker-puppeteer").PuppeteerBlocker
	> | null> {
		if (!DynamicRenderer.blockerPromise) {
			DynamicRenderer.blockerPromise = (async () => {
				try {
					const { PuppeteerBlocker } = await import(
						"@ghostery/adblocker-puppeteer"
					);

					const result = await withTimeoutFallback(
						PuppeteerBlocker.fromLists(globalThis.fetch, [
							"https://easylist.to/easylist/easylist.txt",
							"https://easylist.to/easylist/easylist_cookie.txt",
							"https://easylist.to/easylist/easylist_annoyance.txt",
						]),
						15000,
						null,
					);
					return result;
				} catch {
					return null;
				}
			})();
		}
		return DynamicRenderer.blockerPromise;
	}

	/**
	 * Registers process-level cleanup handlers once for all instances.
	 * Uses a static Set to track active renderers and clean them all on exit.
	 */
	private static registerGlobalHandlers(): void {
		if (DynamicRenderer.handlersRegistered) return;

		const exitHandler = (): void => {
			// Sync-only cleanup on exit — best effort.
			// SIGINT/SIGTERM are handled by server.ts gracefulShutdown which calls
			// session.stop() → dynamicRenderer.close() for every active session.
			// Uncaught exceptions crash fast — the OS reclaims child processes.
			for (const instance of DynamicRenderer.instances) {
				if (instance.browser) {
					instance.browser.close().catch(() => {});
				}
			}
		};

		process.on("exit", exitHandler);

		DynamicRenderer.handlersRegistered = true;
	}

	constructor(options: SanitizedCrawlOptions, logger: Logger) {
		this.options = options;
		this.logger = logger;
		this.browser = null;
		this.browserPid = null;
		this.pageCount = 0;
		this.enabled = options.dynamic !== false;

		// Register instance for cleanup tracking
		DynamicRenderer.instances.add(this);
		DynamicRenderer.registerGlobalHandlers();
	}

	/**
	 * Checks if the dynamic renderer is currently enabled.
	 */
	isEnabled(): boolean {
		return Boolean(this.enabled && this.options.dynamic !== false);
	}

	/**
	 * Disables the dynamic renderer for the rest of the session.
	 *
	 * @param reason - Optional explanation for disabling.
	 */
	disableDynamic(reason?: string): void {
		this.enabled = false;
		if (reason) {
			this.logger.warn(reason);
		}
	}

	/**
	 * Validates memory constraints and attempts to launch the browser instance.
	 */
	async initialize(): Promise<InitializeResult> {
		if (!this.isEnabled()) {
			return { dynamicEnabled: false };
		}

		const memoryStatus = logMemoryStatus(this.logger);
		const constrainedEnvironment =
			memoryStatus.isLowMemory ||
			(config.isRender && memoryStatus.heapUsed > 50);

		if (constrainedEnvironment) {
			this.disableDynamic("Skipping Puppeteer due to constrained memory");
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
				`Failed to launch Puppeteer: ${getErrorMessage(err)}`,
			);
			return {
				dynamicEnabled: false,
				fallbackLog:
					"Falling back to static crawling: dynamic renderer failed to start",
			};
		}
	}

	/**
	 * Launches a new Chromium instance via Puppeteer with optimized flags.
	 */
	async launchBrowser(): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		this.logger.info("Launching Puppeteer (Chromium)...");

		// Dynamic import keeps Chromium out of the module graph at test/import time.
		// Puppeteer is only loaded when a crawl session actually needs the browser.
		const { default: puppeteer } = await import("puppeteer");
		const executablePath = config.puppeteer.executablePath;

		this.browser = await puppeteer.launch({
			headless: true,
			executablePath,
			timeout: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.COMPLEX_NAVIGATION,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				"--disable-blink-features=AutomationControlled",
				"--disable-extensions",
				"--disable-background-networking",
			],
		});

		// Capture browser process PID for force-kill capability
		const process = this.browser.process();
		this.browserPid = process?.pid ?? null;
		if (this.browserPid) {
			this.logger.debug(`Browser PID: ${this.browserPid}`);
		}

		this.pageCount = 0;
		this.enabled = true;
		this.logger.info("Puppeteer launched successfully");
	}

	/**
	 * Re-launches the browser if the page count exceeds the recycling threshold.
	 */
	async recycleIfNeeded(): Promise<void> {
		if (!this.browser) return;

		const recycleThreshold = config.isRender
			? DYNAMIC_RENDERER_CONSTANTS.RECYCLE_THRESHOLD.RENDER_ENV
			: DYNAMIC_RENDERER_CONSTANTS.RECYCLE_THRESHOLD.DEFAULT;
		if (this.pageCount <= recycleThreshold) {
			return;
		}

		this.logger.info("Recycling browser to prevent memory leaks");
		try {
			await withTimeout(this.browser.close(), 10000, "Browser close");
			await this.launchBrowser();
		} catch (err) {
			this.logger.warn(`Error recycling browser: ${getErrorMessage(err)}`);
		}
	}

	/**
	 * Safely extracts page content, title, and description in a single evaluate call.
	 * This minimizes race conditions where the frame could detach between operations.
	 */
	private async safeExtractContent(
		page: Page,
	): Promise<{ content: string; title: string; description: string } | null> {
		const EXTRACTION_TIMEOUT_MS = 10000; // 10 second timeout for content extraction

		try {
			// Check if page is still usable
			if (page.isClosed()) {
				return null;
			}

			// Get content with timeout - page.content() can hang on complex pages
			const content = await withTimeout(
				page.content(),
				EXTRACTION_TIMEOUT_MS,
				"Content extraction",
			);

			// Extract title and description with timeout - evaluate can hang on JS-heavy pages
			const metadata = await withTimeout(
				page.evaluate(() => {
					const title = document.title || "";
					const descMeta = document.querySelector('meta[name="description"]');
					const description = descMeta?.getAttribute("content") || "";
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

	/** Navigates to a URL, waits for content to stabilize, and returns the rendered HTML. */
	async render(item: QueueItem): Promise<DynamicRenderAttempt> {
		if (!this.isEnabled()) {
			return null;
		}

		if (!this.browser) {
			try {
				await this.launchBrowser();
			} catch (err) {
				this.disableDynamic(
					`Failed to relaunch Puppeteer: ${getErrorMessage(err)}`,
				);
				return null;
			}
		}

		await this.recycleIfNeeded();

		if (!this.browser) return null;

		const page = await this.browser.newPage();
		this.pageCount++;

		// Set default timeout for all page operations - root cause fix for hanging
		// This ensures any Puppeteer operation will timeout rather than hang indefinitely
		const pageTimeout = DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.STANDARD_NAVIGATION;
		page.setDefaultTimeout(pageTimeout);
		page.setDefaultNavigationTimeout(pageTimeout);

		let navigationOccurred = false;
		const navigationHandler = () => {
			navigationOccurred = true;
		};

		try {
			await page.setUserAgent(FETCH_HEADERS["User-Agent"]);
			await page.setViewport(DYNAMIC_RENDERER_CONSTANTS.VIEWPORT);
			await page.setExtraHTTPHeaders({
				Accept: FETCH_HEADERS.Accept,
				"Accept-Language": FETCH_HEADERS["Accept-Language"],
				DNT: "1",
			});

			// Set up request interception to block non-essential resources
			// This significantly reduces bandwidth and speeds up page loads
			await page.setRequestInterception(true);
			const blocker = await DynamicRenderer.getBlocker();

			page.on("request", (req) => {
				// Check if already handled (cooperative intercept mode)
				if (req.isInterceptResolutionHandled()) return;

				// Check adblocker for ads, trackers, cookie banners (if available)
				if (blocker) {
					const result = blocker.match({
						type: req.resourceType(),
						url: req.url(),
					} as unknown as Parameters<typeof blocker.match>[0]);
					if (result.match) {
						req.abort();
						return;
					}
				}

				// Block non-essential resources for bandwidth optimization
				const blocked = ["image", "stylesheet", "font", "media"];
				if (blocked.includes(req.resourceType())) {
					req.abort();
				} else {
					req.continue();
				}
			});

			page.on("dialog", (dialog) => {
				dialog.dismiss().catch((err) => {
					this.logger.debug(
						`Failed to dismiss dialog: ${getErrorMessage(err)}`,
					);
				});
			});

			const isComplex = DYNAMIC_RENDERER_CONSTANTS.COMPLEX_JS_SITES.some(
				(site) => item.url.includes(site),
			);
			const waitUntil = "domcontentloaded";
			const navigationTimeout = isComplex
				? DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.COMPLEX_NAVIGATION
				: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.STANDARD_NAVIGATION;

			await this.setCookiesForPage(page, item.url);

			const response = await page.goto(item.url, {
				waitUntil,
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

			// Handle consent modals BEFORE tracking navigation.
			// Consent bypass may trigger a navigation which is expected and desired.
			// We track this to avoid incorrectly aborting on consent-triggered navigations.
			const consentBypass = await this.handleConsentModals(page, item.url);
			if (
				consentBypass.detected &&
				!consentBypass.clicked &&
				requiresStrictConsentBypass(item.url)
			) {
				page.off("framenavigated", navigationHandler);
				await this.closePageSafely(page);
				return {
					type: "consentBlocked",
					message: `Consent wall could not be bypassed for ${item.url}`,
					statusCode:
						response && response.status() >= 400 ? response.status() : 403,
				};
			}

			// Now start tracking navigation for unexpected SPA route changes
			page.on("framenavigated", navigationHandler);

			if (isComplex) {
				await this.waitForComplexContent(page, item.url);
			}

			// Only abort on unexpected navigation (not consent-triggered)
			// Reset navigationOccurred after consent since any prior navigation was expected
			if (consentBypass.clicked) {
				navigationOccurred = false;
			}

			if (navigationOccurred) {
				this.logger.debug(
					`Unexpected navigation during rendering of ${item.url}, falling back to static`,
				);
				page.off("framenavigated", navigationHandler);
				await this.closePageSafely(page);
				return null;
			}

			const extracted = await this.safeExtractContent(page);
			if (!extracted || navigationOccurred) {
				page.off("framenavigated", navigationHandler);
				await this.closePageSafely(page);
				return null;
			}

			const { content, title, description } = extracted;

			if (this.options.screenshots) {
				try {
					const safeHostname = new URL(item.url).hostname.replaceAll(
						/[^a-zA-Z0-9.-]/g,
						"_",
					);
					await page.screenshot({
						path: `./data/screenshots/${safeHostname}_${Date.now()}.jpeg`,
						fullPage: false,
						type: "jpeg",
						quality: 70,
					});
				} catch (error_) {
					this.logger.debug(
						`Screenshot capture failed for ${item.url}: ${getErrorMessage(error_)}`,
					);
				}
			}

			page.off("framenavigated", navigationHandler);
			await page.close();

			return {
				type: "success",
				result: {
					isDynamic: true,
					content,
					statusCode,
					contentType,
					contentLength,
					title,
					description: description || "",
					lastModified,
					xRobotsTag,
				},
			};
		} catch (err) {
			page.off("framenavigated", navigationHandler);
			await this.closePageSafely(page);

			if (isRecoverableBrowserError(err)) {
				this.logger.debug(
					`Recoverable browser error for ${item.url}, falling back to static crawling: ${getErrorMessage(err)}`,
				);
				return null;
			}

			// Unknown errors - log and fallback instead of crashing
			this.logger.warn(
				`Unexpected error during dynamic rendering of ${item.url}: ${getErrorMessage(err)}`,
			);
			return null;
		}
	}

	/**
	 * Attempts to detect and click "Accept" buttons on consent walls (Google/YouTube/GDPR).
	 * This allows the crawler to access the actual content behind the "Before you continue" screens.
	 *
	 * NOTE: page.evaluate() has no built-in timeout. On JS-heavy pages (YouTube SPA), Chrome's V8
	 * may be busy executing framework init code, causing CDP commands to hang indefinitely.
	 * All evaluate() calls are wrapped in Promise.race() with a timeout.
	 * textContent is used instead of innerText to avoid expensive layout reflow.
	 *
	 * @returns true if consent was clicked and navigation may occur, false otherwise
	 */
	async handleConsentModals(
		page: Page,
		url: string,
	): Promise<ConsentBypassResult> {
		const EVAL_TIMEOUT_MS = DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.CONSENT_EVAL;
		const NAV_TIMEOUT_MS =
			DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.CONSENT_NAVIGATION;

		try {
			const bodyText = await withTimeoutFallback(
				page.evaluate(() => {
					return document.body?.textContent ?? "";
				}),
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
					page.waitForNavigation({
						waitUntil: "domcontentloaded",
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

	/**
	 * Waits for specific elements on well-known complex JS sites to ensure content is loaded.
	 * Selectors are configured in SITE_SELECTORS constant for easy maintenance.
	 */
	async waitForComplexContent(page: Page, url: string): Promise<void> {
		try {
			const additionalWaitTime =
				DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.ADDITIONAL_WAIT;

			// Find matching selector from configuration
			const selectorToWait = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			if (selectorToWait) {
				await page.waitForSelector(selectorToWait, {
					timeout: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.SELECTOR_WAIT,
				});
				this.logger.debug(`Waited for selector: ${selectorToWait} on ${url}`);
			}

			await Bun.sleep(additionalWaitTime);
		} catch (error_) {
			this.logger.warn(
				`Complex site selector wait failed for ${url}: ${getErrorMessage(error_)}`,
			);
		}
	}

	/**
	 * Sets necessary cookies (e.g., for age verification) to bypass interstitial pages.
	 * Cookies are configured in SITE_COOKIES constant for easy maintenance.
	 *
	 * Uses tldts to correctly extract the root domain for any URL, handling
	 * public suffixes like .co.uk, .com.au, .co.jp, etc.
	 */
	async setCookiesForPage(page: Page, url: string): Promise<void> {
		try {
			// Find matching cookies from configuration
			const siteCookies = Object.entries(SITE_COOKIES).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			if (!siteCookies || siteCookies.length === 0) {
				return;
			}

			// Use tldts for robust domain parsing that handles all public suffixes
			const { parse } = await import("tldts");
			const parsed = parse(url);

			if (!parsed.domain) {
				this.logger.debug(`Could not parse domain from ${url}`);
				return;
			}

			// Set cookies on the root domain (e.g., .youtube.com) so they work
			// across all subdomains (www, m, music, etc.)
			const cookieDomain = `.${parsed.domain}`;

			const cookiesToSet = siteCookies.map((cookie) => ({
				...cookie,
				domain: cookieDomain,
				path: "/",
			}));
			await withTimeout(
				page.setCookie(...cookiesToSet),
				5000,
				"Cookie setting",
			);
			this.logger.debug(
				`Set ${cookiesToSet.length} cookies for ${cookieDomain}`,
			);
		} catch (error_) {
			this.logger.debug(`Cookie setting failed: ${getErrorMessage(error_)}`);
		}
	}

	/**
	 * Attempts to close a page instance safely without throwing on already-closed targets.
	 */
	async closePageSafely(page: Page): Promise<void> {
		try {
			if (!page.isClosed()) {
				await page.close();
			}
		} catch (error_) {
			const message = getErrorMessage(error_);
			// Targets might be closed asynchronously during cleanup
			if (
				!message.includes("Target closed") &&
				!message.includes("No target with given id")
			) {
				this.logger.debug(`Error closing page: ${message}`);
			}
		}
	}

	/**
	 * Closes the browser and removes this instance from cleanup tracking.
	 * If browser.close() hangs, falls back to force-killing the process.
	 */
	async close(): Promise<void> {
		// Remove from instance tracking
		DynamicRenderer.instances.delete(this);

		if (!this.browser) return;

		try {
			// Try graceful close with timeout
			const closePromise = this.browser.close();
			const timeoutPromise = Bun.sleep(5000).then(() => {
				throw new Error("Browser close timeout");
			});
			await Promise.race([closePromise, timeoutPromise]);
			this.logger.info("Puppeteer closed.");
		} catch (err) {
			const message = getErrorMessage(err);
			this.logger.warn(`Browser close failed: ${message}`);

			// Force-kill browser process if we have the PID
			if (this.browserPid) {
				try {
					process.kill(this.browserPid, "SIGKILL");
					this.logger.info(
						`Force-killed browser process (PID: ${this.browserPid})`,
					);
				} catch (killErr) {
					this.logger.debug(
						`Failed to kill browser process: ${getErrorMessage(killErr)}`,
					);
				}
			}
		} finally {
			this.browser = null;
			this.browserPid = null;
			this.pageCount = 0;
		}
	}
}
