import puppeteer, { type Browser, type Page } from "puppeteer";
import { config } from "../config/env.js";
import type { Logger } from "../config/logging.js";
import {
	DYNAMIC_RENDERER_CONSTANTS,
	FETCH_HEADERS,
	SITE_COOKIES,
	SITE_SELECTORS,
} from "../constants.js";
import type {
	DynamicRenderResult,
	QueueItem,
	SanitizedCrawlOptions,
} from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";
import { logMemoryStatus } from "../utils/memoryMonitor.js";

interface InitializeResult {
	dynamicEnabled: boolean;
	fallbackLog?: string;
}

/**
 * Handles dynamic page rendering using Puppeteer to support SPA and JS-heavy sites.
 *
 * NOTE: This is resource-intensive. We use aggressive recycling and memory
 * checks to prevent the crawler from crashing the host system.
 */
export class DynamicRenderer {
	private static readonly instances = new Set<DynamicRenderer>();
	private static handlersRegistered = false;

	private readonly options: SanitizedCrawlOptions;
	private readonly logger: Logger;
	private browser: Browser | null;
	private pageCount: number;
	private enabled: boolean;

	/**
	 * Registers process-level cleanup handlers once for all instances.
	 * Uses a static Set to track active renderers and clean them all on exit.
	 */
	private static registerGlobalHandlers(): void {
		if (DynamicRenderer.handlersRegistered) return;

		const cleanupAll = async (): Promise<void> => {
			const closePromises = [...DynamicRenderer.instances].map((instance) =>
				instance.close().catch(() => {}),
			);
			await Promise.all(closePromises);
		};

		const exitHandler = (): void => {
			// Sync cleanup on exit - best effort
			for (const instance of DynamicRenderer.instances) {
				if (instance.browser) {
					instance.browser.close().catch(() => {});
				}
			}
		};

		const uncaughtHandler = async (err: Error): Promise<void> => {
			console.error(`Uncaught Exception: ${err.message}`);
			await cleanupAll();
			process.exit(1);
		};

		process.on("exit", exitHandler);
		process.on("SIGINT", cleanupAll);
		process.on("SIGTERM", cleanupAll);
		process.on("uncaughtException", uncaughtHandler);

		DynamicRenderer.handlersRegistered = true;
	}

	constructor(options: SanitizedCrawlOptions, logger: Logger) {
		this.options = options;
		this.logger = logger;
		this.browser = null;
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
			await this.browser.close();
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
		try {
			// Check if page is still usable
			if (page.isClosed()) {
				return null;
			}

			// Get content first (most important)
			const content = await page.content();

			// Extract title and description in a single evaluate to minimize frame access
			const metadata = await page.evaluate(() => {
				const title = document.title || "";
				const descMeta = document.querySelector('meta[name="description"]');
				const description = descMeta?.getAttribute("content") || "";
				return { title, description };
			});

			return {
				content,
				title: metadata.title,
				description: metadata.description,
			};
		} catch (err) {
			const message = getErrorMessage(err);
			// Frame detachment is expected on SPAs - return null to trigger static fallback
			if (
				message.includes("detached Frame") ||
				message.includes("Execution context was destroyed") ||
				message.includes("Target closed")
			) {
				return null;
			}
			throw err;
		}
	}

	/** Navigates to a URL, waits for content to stabilize, and returns the rendered HTML. */
	async render(item: QueueItem): Promise<DynamicRenderResult | null> {
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

		// Track if navigation happens mid-extraction (SPA route changes)
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

			page.on("dialog", (dialog) => dialog.dismiss());

			const isComplex = DYNAMIC_RENDERER_CONSTANTS.COMPLEX_JS_SITES.some(
				(site) => item.url.includes(site),
			);
			const waitUntil = isComplex ? "networkidle0" : "domcontentloaded";
			const navigationTimeout = isComplex
				? DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.COMPLEX_NAVIGATION
				: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.STANDARD_NAVIGATION;

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

			await this.setCookiesForPage(page, item.url);

			// Start tracking navigation after initial page load
			page.on("framenavigated", navigationHandler);

			if (isComplex) {
				await this.waitForComplexContent(page, item.url);
			}

			// Abort if SPA navigated away during wait
			if (navigationOccurred) {
				this.logger.debug(
					`Navigation occurred during rendering of ${item.url}, falling back to static`,
				);
				page.off("framenavigated", navigationHandler);
				await this.closePageSafely(page);
				return null;
			}

			// Use safe extraction to handle frame detachment gracefully
			const extracted = await this.safeExtractContent(page);
			if (!extracted || navigationOccurred) {
				page.off("framenavigated", navigationHandler);
				await this.closePageSafely(page);
				return null; // Fall back to static crawling
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
				isDynamic: true,
				content,
				statusCode,
				contentType,
				contentLength,
				title,
				description: description || "",
				lastModified,
			};
		} catch (err) {
			page.off("framenavigated", navigationHandler);
			await this.closePageSafely(page);

			const errorMessage = err instanceof Error ? err.message : "";

			// Handle recoverable browser/page errors by falling back to static crawling
			if (
				errorMessage.includes("Target closed") ||
				errorMessage.includes("Session closed") ||
				errorMessage.includes("Connection closed") ||
				errorMessage.includes("detached Frame") ||
				errorMessage.includes("Execution context was destroyed")
			) {
				this.logger.debug(
					`Browser context error for ${item.url}, falling back to static crawling`,
				);
				return null;
			}

			if (errorMessage.includes("Timeout")) {
				this.logger.debug(
					`Navigation timeout for ${item.url}, falling back to static crawling`,
				);
				return null;
			}

			throw err;
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

			await new Promise((resolve) => setTimeout(resolve, additionalWaitTime));
		} catch (error_) {
			this.logger.warn(
				`Complex site selector wait failed for ${url}: ${getErrorMessage(error_)}`,
			);
		}
	}

	/**
	 * Sets necessary cookies (e.g., for age verification) to bypass interstitial pages.
	 * Cookies are configured in SITE_COOKIES constant for easy maintenance.
	 */
	async setCookiesForPage(page: Page, url: string): Promise<void> {
		try {
			const urlDomain = new URL(url).hostname;

			// Find matching cookies from configuration
			const siteCookies = Object.entries(SITE_COOKIES).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			if (siteCookies && siteCookies.length > 0) {
				const cookiesToSet = siteCookies.map((cookie) => ({
					...cookie,
					domain: urlDomain,
					path: "/",
				}));
				await page.setCookie(...cookiesToSet);
			}
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
	 */
	async close(): Promise<void> {
		// Remove from instance tracking
		DynamicRenderer.instances.delete(this);

		if (!this.browser) return;
		try {
			await this.browser.close();
			this.logger.info("Puppeteer closed.");
		} catch (err) {
			this.logger.error(`Error closing browser: ${getErrorMessage(err)}`);
		} finally {
			this.browser = null;
			this.pageCount = 0;
		}
	}
}
