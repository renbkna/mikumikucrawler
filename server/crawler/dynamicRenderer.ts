import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Dialog, type Page } from "puppeteer";
import type { Logger } from "winston";
import type {
	DynamicRenderResult,
	QueueItem,
	SanitizedCrawlOptions,
} from "../types.js";
import { getChromePaths } from "../utils/helpers.js";
import { logMemoryStatus } from "../utils/memoryMonitor.js";

const COMPLEX_JS_SITES = [
	"youtube.com",
	"google.com",
	"facebook.com",
	"meta.com",
	"twitter.com",
	"x.com",
	"instagram.com",
	"linkedin.com",
	"discord.com",
	"reddit.com",
	"pinterest.com",
	"tiktok.com",
	"netflix.com",
	"amazon.com",
	"airbnb.com",
	"uber.com",
	"spotify.com",
	"github.com",
	"stackoverflow.com",
	"medium.com",
	"twitch.tv",
	"salesforce.com",
	"slack.com",
	"notion.so",
	"figma.com",
	"canva.com",
	"trello.com",
	"asana.com",
	"dropbox.com",
	"zoom.us",
];

const DEFAULT_LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-gpu",
	"--disable-background-networking",
	"--disable-sync",
	"--disable-default-apps",
	"--disable-extensions",
	"--disable-translate",
	"--mute-audio",
	"--no-first-run",
	"--metrics-recording-only",
	"--disable-background-mode",
	"--disable-popup-blocking",
	"--window-size=1280,720",
];

interface InitializeResult {
	dynamicEnabled: boolean;
	fallbackLog?: string;
}

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

		// cleanup on process exit
		const cleanup = async (): Promise<void> => {
			if (this.browser) {
				this.logger.info("Process exiting, closing Puppeteer...");
				await this.close();
			}
		};

		// Bind the cleanup function
		this._cleanupHandler = cleanup.bind(this);

		// Store uncaughtException handler reference for proper cleanup
		this._uncaughtExceptionHandler = async (err: Error): Promise<void> => {
			this.logger.error(`Uncaught Exception: ${err.message}`);
			await cleanup();
			process.exit(1);
		};

		// Register handlers
		process.on("exit", this._cleanupHandler);
		process.on("SIGINT", this._cleanupHandler);
		process.on("SIGTERM", this._cleanupHandler);
		process.on("uncaughtException", this._uncaughtExceptionHandler);
		this._handlersRegistered = true;
	}

	isEnabled(): boolean {
		return Boolean(this.enabled && this.options.dynamic !== false);
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
					"Falling back to static crawling: dynamic renderer failed to start (requires ~1GB RAM)",
			};
		}
	}

	async launchBrowser(): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		const chromePaths = await getChromePaths();
		let executablePath: string | null = null;
		for (const chromePath of chromePaths) {
			if (chromePath && existsSync(chromePath)) {
				executablePath = chromePath;
				this.logger.info(`Found Chrome executable at: ${chromePath}`);
				break;
			}
		}

		const launchOptions: {
			headless: boolean;
			args: string[];
			timeout: number;
			protocolTimeout: number;
			slowMo: number;
			executablePath?: string;
		} = {
			headless: true,
			args: DEFAULT_LAUNCH_ARGS,
			timeout: 45000,
			protocolTimeout: 45000,
			slowMo: 100,
		};

		if (executablePath) {
			launchOptions.executablePath = executablePath;
		}

		this.logger.info(
			`Launching Puppeteer with config: ${JSON.stringify({
				executablePath: launchOptions.executablePath,
				args: launchOptions.args,
			})}`,
		);

		this.browser = await puppeteer.launch(launchOptions);
		this.pageCount = 0;
		this.enabled = true;
	}

	async recycleIfNeeded(): Promise<void> {
		if (!this.browser) return;

		const recycleThreshold = process.env.RENDER ? 50 : 200;
		if (this.pageCount <= recycleThreshold) {
			return;
		}

		this.logger.info("Recycling browser to prevent memory leaks");
		try {
			await this.browser.close();
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			this.logger.warn(`Error closing old browser: ${message}`);
		}

		this.browser = null;
		await this.launchBrowser();
	}

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

		if (!this.browser) {
			return null;
		}

		const page = await this.browser.newPage();
		this.pageCount++;

		try {
			// Use CDP to set user agent (avoids deprecated page.setUserAgent)
			const cdpSession = await page.createCDPSession();
			await cdpSession.send("Network.setUserAgentOverride", {
				userAgent:
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				userAgentMetadata: {
					platform: "Windows",
					platformVersion: "10.0.0",
					architecture: "x86",
					model: "",
					mobile: false,
					brands: [
						{ brand: "Chromium", version: "120" },
						{ brand: "Google Chrome", version: "120" },
					],
				},
			});
			await page.setViewport({ width: 1280, height: 720 });
			page.on("dialog", async (dialog: Dialog) => {
				await dialog.dismiss();
			});
			await page.setExtraHTTPHeaders({
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
				"Accept-Encoding": "gzip, deflate",
				DNT: "1",
				Connection: "keep-alive",
				"Upgrade-Insecure-Requests": "1",
			});

			const isComplex = COMPLEX_JS_SITES.some((site) =>
				item.url.includes(site),
			);
			const waitUntil = isComplex ? "networkidle0" : "domcontentloaded";
			const navigationTimeout = isComplex ? 60000 : 30000;

			const response = await page.goto(item.url, {
				waitUntil,
				timeout: navigationTimeout,
			});

			const statusCode = response?.status() ?? 0;
			const headers = response?.headers?.() ?? {};
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
				.$eval(
					'meta[name="description"]',
					(el) => (el as unknown as { content: string }).content,
				)
				.catch(() => "");

			if (this.options.screenshots) {
				try {
					// Sanitize hostname to prevent path traversal
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
				description,
				lastModified,
			};
		} catch (err) {
			await this.closePageSafely(page);

			const errorMessage = err instanceof Error ? err.message : "";
			if (
				errorMessage.includes("Protocol error") ||
				errorMessage.includes("Connection closed") ||
				errorMessage.includes("Navigating frame was detached") ||
				errorMessage.includes("Target closed") ||
				errorMessage.includes("Session closed")
			) {
				this.logger.warn(
					`Browser session error detected, falling back to static crawling for ${item.url}`,
				);
				return null;
			}

			if (errorMessage.includes("TimeoutError")) {
				this.logger.warn(
					`Navigation timeout for ${item.url}, falling back to static crawling`,
				);
				return null;
			}

			throw err;
		}
	}

	async waitForComplexContent(page: Page, url: string): Promise<void> {
		try {
			let selectorToWait: string | null = null;
			const additionalWaitTime = 2000;

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
				await page.waitForSelector(selectorToWait, { timeout: 15000 });
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

	async setCookiesForPage(page: Page, url: string): Promise<void> {
		try {
			const urlDomain = new URL(url).hostname;
			const cookiesToSet: Array<{ name: string; value: string }> = [];

			if (url.includes("youtube.com")) {
				cookiesToSet.push(
					{ name: "CONSENT", value: "YES+" },
					{ name: "PREF", value: "tz=UTC" },
				);
			} else if (url.includes("reddit.com")) {
				cookiesToSet.push({ name: "over18", value: "1" });
			}

			// Use browser context's setCookie to avoid deprecated page.setCookie spread signature
			if (cookiesToSet.length > 0) {
				const context = page.browserContext();
				await context.setCookie(
					...cookiesToSet.map((cookie) => ({
						name: cookie.name,
						value: cookie.value,
						domain: urlDomain,
					})),
				);
			}
		} catch (error_) {
			const message =
				error_ instanceof Error ? error_.message : "Unknown error";
			this.logger.debug(`Cookie setting failed: ${message}`);
		}
	}

	async closePageSafely(page: Page): Promise<void> {
		try {
			await page.close();
		} catch (error_) {
			const message =
				error_ instanceof Error ? error_.message : "Unknown error";
			this.logger.error(`Error closing page: ${message}`);
		}
	}

	async close(): Promise<void> {
		// Unregister process handlers to prevent memory leaks
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
