import puppeteer, { type Browser, type Page } from "puppeteer";
import type { Logger } from "winston";
import { DYNAMIC_RENDERER_CONSTANTS } from "../constants.js";
import type {
	DynamicRenderResult,
	QueueItem,
	SanitizedCrawlOptions,
} from "../types.js";
import { logMemoryStatus } from "../utils/memoryMonitor.js";

interface InitializeResult {
	dynamicEnabled: boolean;
	fallbackLog?: string;
}

/** Handles dynamic page rendering using Puppeteer to support SPA and JS-heavy sites. */
export class DynamicRenderer {
	private readonly options: SanitizedCrawlOptions;
	private readonly logger: Logger;
	private browser: Browser | null;
	private pageCount: number;
	private enabled: boolean;
	private _handlersRegistered: boolean;
	private readonly _cleanupHandler: () => Promise<void>;
	private readonly _uncaughtExceptionHandler: (err: Error) => Promise<void>;

	constructor(options: SanitizedCrawlOptions, logger: Logger) {
		this.options = options;
		this.logger = logger;
		this.browser = null;
		this.pageCount = 0;
		this.enabled = options.dynamic !== false;
		this._handlersRegistered = false;

		const cleanup = async (): Promise<void> => {
			if (this.browser) {
				this.logger.info("Process exiting, closing Puppeteer...");
				await this.close();
			}
		};

		this._cleanupHandler = cleanup.bind(this);

		this._uncaughtExceptionHandler = async (err: Error): Promise<void> => {
			this.logger.error(`Uncaught Exception: ${err.message}`);
			await cleanup();
			process.exit(1);
		};

		process.on("exit", this._cleanupHandler);
		process.on("SIGINT", this._cleanupHandler);
		process.on("SIGTERM", this._cleanupHandler);
		process.on("uncaughtException", this._uncaughtExceptionHandler);
		this._handlersRegistered = true;
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
			(process.env.RENDER && memoryStatus.heapUsed > 50);

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
			const message = err instanceof Error ? err.message : "Unknown error";
			this.disableDynamic(`Failed to launch Puppeteer: ${message}`);
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

		this.browser = await puppeteer.launch({
			headless: true,
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

		const recycleThreshold = process.env.RENDER
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
			const message = err instanceof Error ? err.message : "Unknown error";
			this.logger.warn(`Error recycling browser: ${message}`);
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
				const message = err instanceof Error ? err.message : "Unknown error";
				this.disableDynamic(`Failed to relaunch Puppeteer: ${message}`);
				return null;
			}
		}

		await this.recycleIfNeeded();

		if (!this.browser) return null;

		const page = await this.browser.newPage();
		this.pageCount++;

		try {
			await page.setUserAgent(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			);
			await page.setViewport(DYNAMIC_RENDERER_CONSTANTS.VIEWPORT);
			await page.setExtraHTTPHeaders({
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
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

			if (isComplex) {
				await this.waitForComplexContent(page, item.url);
			}

			const content = await page.content();
			const title = await page.title();
			const description = await page
				.$eval('meta[name="description"]', (el) => el.getAttribute("content"))
				.catch(() => "");

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
					const message =
						error_ instanceof Error ? error_.message : "Unknown error";
					this.logger.debug(
						`Screenshot capture failed for ${item.url}: ${message}`,
					);
				}
			}

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
			await this.closePageSafely(page);

			const errorMessage = err instanceof Error ? err.message : "";
			if (
				errorMessage.includes("Target closed") ||
				errorMessage.includes("Session closed") ||
				errorMessage.includes("Connection closed")
			) {
				this.logger.warn(
					`Browser session error detected, falling back to static crawling for ${item.url}`,
				);
				return null;
			}

			if (errorMessage.includes("Timeout")) {
				this.logger.warn(
					`Navigation timeout for ${item.url}, falling back to static crawling`,
				);
				return null;
			}

			throw err;
		}
	}

	/**
	 * Waits for specific elements on well-known complex JS sites to ensure content is loaded.
	 */
	async waitForComplexContent(page: Page, url: string): Promise<void> {
		try {
			let selectorToWait: string | null = null;
			const additionalWaitTime =
				DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.ADDITIONAL_WAIT;

			if (url.includes("youtube.com/watch")) {
				selectorToWait = "h1.ytd-video-primary-info-renderer";
			} else if (url.includes("twitter.com") || url.includes("x.com")) {
				selectorToWait = '[data-testid="tweet"]';
			} else if (url.includes("linkedin.com")) {
				selectorToWait = ".feed-container-theme";
			} else if (url.includes("instagram.com")) {
				selectorToWait = '[role="main"]';
			} else if (url.includes("reddit.com")) {
				selectorToWait = '[data-testid="post-container"]';
			} else if (url.includes("facebook.com") || url.includes("meta.com")) {
				selectorToWait = '[role="main"]';
			} else if (url.includes("github.com")) {
				selectorToWait = ".js-repo-root, .repository-content";
			} else if (url.includes("medium.com")) {
				selectorToWait = "article";
			} else if (url.includes("stackoverflow.com")) {
				selectorToWait = ".question, .answer";
			}

			if (selectorToWait) {
				await page.waitForSelector(selectorToWait, {
					timeout: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.SELECTOR_WAIT,
				});
				this.logger.debug(`Waited for selector: ${selectorToWait} on ${url}`);
			}

			await new Promise((resolve) => setTimeout(resolve, additionalWaitTime));
		} catch (error_) {
			const message =
				error_ instanceof Error ? error_.message : "Unknown error";
			this.logger.warn(
				`Complex site selector wait failed for ${url}: ${message}`,
			);
		}
	}

	/**
	 * Sets necessary cookies (e.g., for age verification) to bypass interstitial pages.
	 */
	async setCookiesForPage(page: Page, url: string): Promise<void> {
		try {
			const urlDomain = new URL(url).hostname;
			const cookiesToSet: Array<{
				name: string;
				value: string;
				domain: string;
				path: string;
			}> = [];

			if (url.includes("youtube.com")) {
				cookiesToSet.push(
					{ name: "CONSENT", value: "YES+", domain: urlDomain, path: "/" },
					{ name: "PREF", value: "tz=UTC", domain: urlDomain, path: "/" },
				);
			} else if (url.includes("reddit.com")) {
				cookiesToSet.push({
					name: "over18",
					value: "1",
					domain: urlDomain,
					path: "/",
				});
			}

			if (cookiesToSet.length > 0) {
				await page.setCookie(...cookiesToSet);
			}
		} catch (error_) {
			const message =
				error_ instanceof Error ? error_.message : "Unknown error";
			this.logger.debug(`Cookie setting failed: ${message}`);
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
			const message =
				error_ instanceof Error ? error_.message : "Unknown error";
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
	 * Closes the browser and removes process-level event listeners.
	 */
	async close(): Promise<void> {
		if (this._handlersRegistered) {
			process.off("exit", this._cleanupHandler);
			process.off("SIGINT", this._cleanupHandler);
			process.off("SIGTERM", this._cleanupHandler);
			process.off("uncaughtException", this._uncaughtExceptionHandler);
			this._handlersRegistered = false;
		}

		if (!this.browser) return;
		try {
			await this.browser.close();
			this.logger.info("Puppeteer closed.");
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			this.logger.error(`Error closing browser: ${message}`);
		} finally {
			this.browser = null;
			this.pageCount = 0;
		}
	}
}
