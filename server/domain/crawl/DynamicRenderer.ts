import { type Browser, chromium, type Page } from "playwright";
import type { CrawlOptions } from "../../../shared/contracts/index.js";
import { normalizeCanonicalHttpUrl } from "../../../shared/url.js";
import { resolveChromiumExecutable } from "../../config/browser.js";
import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import { DYNAMIC_RENDERER_CONSTANTS, FETCH_HEADERS, TIMEOUT_CONSTANTS } from "../../constants.js";
import type { HttpClient } from "../../outbound/HttpClient.js";
import { getErrorMessage } from "../../utils/helpers.js";
import { isUnresolvedStrictConsentWall } from "./consent.js";
import {
	extractRenderedSnapshot,
	isRecoverableBrowserError,
	openBrowserPageWithRetry,
	type RenderedSnapshot,
	waitForAbort,
} from "./rendering/browserPage.js";
import { handleConsentModals } from "./rendering/consentInteraction.js";
import type {
	CrawlRenderer,
	DestinationAuthorizer,
	DynamicRenderAttempt,
	InitializeResult,
} from "./rendering/contracts.js";
import {
	configurePinnedBrowserContext,
	createDynamicBrowserContextOptions,
	createDynamicBrowserLaunchArgs,
	type DynamicDocumentResponse,
	type DynamicRouteResult,
} from "./rendering/pinnedBrowserNetwork.js";

type BrowserLauncher = (options: Parameters<typeof chromium.launch>[0]) => Promise<Browser>;

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

/**
 * Dynamic renderer contract:
 * - owns one crawl-scoped browser and one isolated context per rendered page
 * - classifies dynamic fetches as success, consentBlocked, or static fallback
 * - never uses Playwright's native HTTP(S) network path; browser requests are
 *   fulfilled through the same pinned HTTP client used by static crawling
 */
export class DynamicRenderer implements CrawlRenderer {
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

	private disableDynamic(reason?: string): void {
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

	private async launchBrowser(signal?: AbortSignal): Promise<void> {
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
		url: string,
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
			url === this.options.target ? url : undefined,
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
		url: string,
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
			url: url,
		};
		const closeOnAbort = () => {
			abortCleanup ??= this.closePageSafely(page);
		};
		signal?.addEventListener("abort", closeOnAbort, { once: true });

		try {
			signal?.throwIfAborted();
			await this.configurePage(
				page,
				url,
				signal,
				(result, url) => {
					documentState.response =
						result.type === "fulfilled" ? (result.documentResponse ?? null) : null;
					documentState.url = documentState.response?.url ?? url;
					documentRouteFailure ??= classifyDocumentRouteFailure(result, url);
				},
				authorizeDestination,
			);
			signal?.throwIfAborted();

			await page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: TIMEOUT_CONSTANTS.DOCUMENT_FETCH,
			});
			signal?.throwIfAborted();
			if (documentRouteFailure) {
				return documentRouteFailure;
			}

			const consentBypass = await handleConsentModals(page, documentState.url, this.logger, signal);
			signal?.throwIfAborted();
			if (documentRouteFailure) {
				return documentRouteFailure;
			}
			if (isUnresolvedStrictConsentWall(consentBypass, documentState.url)) {
				const statusCode = documentState.response?.statusCode ?? 200;
				return {
					type: "consentBlocked",
					message: `Consent wall could not be bypassed for ${documentState.url}`,
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
					`Recoverable browser error for ${url}, falling back to static crawling: ${getErrorMessage(err)}`,
				);
				return {
					type: "staticFallback",
					reason: "content-unavailable",
					targetUrl: documentState.url,
				};
			}

			this.logger.warn(
				`Unexpected error during dynamic rendering of ${url}: ${getErrorMessage(err)}`,
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

	private async closePageSafely(page: Page): Promise<void> {
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
