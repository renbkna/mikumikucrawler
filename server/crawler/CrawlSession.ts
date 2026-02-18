import type { Database } from "bun:sqlite";
import { config } from "../config/env.js";
import type { Logger } from "../config/logging.js";
import type {
	CrawlerSocket,
	QueueItem,
	SanitizedCrawlOptions,
} from "../types.js";
import { getErrorMessage, getRobotsRules } from "../utils/helpers.js";
import { RequestCoalescer } from "../utils/requestCoalescer.js";
import { DynamicRenderer } from "./dynamicRenderer.js";
import { CrawlQueue } from "./modules/crawlQueue.js";
import { CrawlState } from "./modules/crawlState.js";
import { createPagePipeline } from "./modules/pagePipeline.js";

/** Manages the lifecycle of a single crawl operation. */
export class CrawlSession {
	private readonly socket: CrawlerSocket;
	private readonly db: Database;
	private readonly logger: Logger;
	private readonly options: SanitizedCrawlOptions;
	private readonly state: CrawlState;
	private readonly dynamicRenderer: DynamicRenderer;
	private readonly targetDomain: string;
	private readonly queue: CrawlQueue;
	/** Per-session coalescer — prevents duplicate in-flight fetches within this session only.
	 *  Scoped to each CrawlSession so two users crawling the same URL never share results. */
	private readonly coalescer: RequestCoalescer;
	/**
	 * Assigned after the queue is created (circular dep: pipeline needs queue,
	 * queue's processItem closure captures pipeline lazily via `this`).
	 * The `!` assertion is safe because start() can only be called after the
	 * constructor completes.
	 */
	private pipeline!: (item: QueueItem) => Promise<void>;
	/**
	 * Memoises the in-progress shutdown promise so concurrent callers to stop()
	 * all await the same teardown sequence instead of racing to close resources.
	 */
	private stopPromise: Promise<void> | null = null;

	constructor(
		socket: CrawlerSocket,
		options: SanitizedCrawlOptions,
		db: Database,
		logger: Logger,
	) {
		this.socket = socket;
		this.db = db;
		this.logger = logger;

		this.options = {
			target: options.target,
			crawlDepth: options.crawlDepth,
			maxPages: options.maxPages,
			crawlDelay: options.crawlDelay,
			crawlMethod: options.crawlMethod,
			maxConcurrentRequests: options.maxConcurrentRequests,
			retryLimit: options.retryLimit,
			dynamic: options.dynamic,
			respectRobots: options.respectRobots,
			saveMedia: options.saveMedia,
			contentOnly: options.contentOnly,
		};

		this.state = new CrawlState(this.options);
		this.dynamicRenderer = new DynamicRenderer(this.options, this.logger);
		this.coalescer = new RequestCoalescer();

		this.targetDomain = "";
		try {
			const url = new URL(this.options.target);
			this.targetDomain = url.hostname;
		} catch {
			this.logger.error(`Invalid target URL: ${this.options.target}`);
		}

		if (this.targetDomain) {
			this.state.setDomainDelay(this.targetDomain, this.options.crawlDelay);
		}

		this.queue = new CrawlQueue({
			options: this.options,
			state: this.state,
			logger: this.logger,
			socket: this.socket,
			processItem: async () => {},
			onIdle: async () => {
				await this.stop();
			},
		});

		this.pipeline = createPagePipeline({
			options: this.options,
			state: this.state,
			logger: this.logger,
			socket: this.socket,
			db: this.db,
			dynamicRenderer: this.dynamicRenderer,
			queue: this.queue,
			targetDomain: this.targetDomain,
		});

		// Use per-session request coalescing to prevent duplicate simultaneous
		// fetches of the same URL within this session. Unlike a global coalescer,
		// this does NOT share results across different user sessions.
		this.queue.processItem = async (item: QueueItem) => {
			await this.coalescer.coalesce(item.url, () => this.pipeline(item));
		};
	}

	/**
	 * Initializes the crawl pipeline:
	 * 1. Preps the dynamic renderer (Playwright) if enabled.
	 * 2. Checks robots.txt compliance for the target domain.
	 * 3. Seeds the queue with the initial URL.
	 */
	async start(): Promise<void> {
		try {
			const initResult = await this.dynamicRenderer.initialize();
			if (!initResult.dynamicEnabled && initResult.fallbackLog) {
				this.socket.emit("stats", {
					...this.state.stats,
					log: initResult.fallbackLog,
				});
			}

			if (this.options.respectRobots && this.targetDomain) {
				try {
					const robots = await getRobotsRules(
						this.targetDomain,
						this.db,
						this.logger,
					);

					if (
						robots &&
						!robots.isAllowed(this.options.target, config.userAgent)
					) {
						this.socket.emit("stats", {
							...this.state.stats,
							log: `[Crawler] Robots.txt disallows crawling this target; stopping.`,
						});
						this.logger.warn(
							`Robots.txt disallows crawling ${this.options.target}`,
						);

						this.db
							.query(
								"INSERT OR REPLACE INTO domain_settings (domain, allowed) VALUES (?, 0)",
							)
							.run(this.targetDomain);

						await this.stop();
						return;
					}

					const crawlDelay = robots?.getCrawlDelay?.(config.userAgent);
					if (crawlDelay) {
						const delayMs = Math.max(
							crawlDelay * 1000,
							this.options.crawlDelay,
						);
						this.state.setDomainDelay(this.targetDomain, delayMs);
						this.logger.info(
							`Using robots.txt crawl delay for ${this.targetDomain}: ${delayMs}ms`,
						);
					}
				} catch (err) {
					const message = getErrorMessage(err);
					this.logger.error(`Error checking robots.txt: ${message}`);
				}
			}

			this.queue.enqueue({ url: this.options.target, depth: 0, retries: 0 });
			this.queue.start();
		} catch (err) {
			const message = getErrorMessage(err);
			this.logger.error(`Error starting crawl: ${message}`);
			this.socket.emit("stats", {
				...this.state.stats,
				log: `[Crawler] Error starting crawler: ${message}`,
			});
			await this.stop();
		}
	}

	/**
	 * Stops the crawler, clearing the queue and closing the renderer.
	 * Idempotent and race-safe: concurrent callers all await the same shutdown
	 * promise so resources (e.g. dynamicRenderer) are never closed twice.
	 */
	stop(): Promise<void> {
		// Already shutting down or fully stopped — return the cached promise.
		if (this.stopPromise) {
			return this.stopPromise;
		}

		// Never started, or already stopped without a pending promise.
		if (!this.state.isActive) {
			return Promise.resolve();
		}

		// Flip the active flag synchronously so any concurrent caller that
		// reaches here before the microtask queue drains will see isActive===false
		// and hit the branch above on their next tick.
		this.state.stop();
		this.stopPromise = this._teardown();
		return this.stopPromise;
	}

	/** Performs the actual async teardown.  Only ever called once via stop(). */
	private async _teardown(): Promise<void> {
		this.queue.clearRetries();
		await this.queue.awaitIdle();
		await this.dynamicRenderer.close();

		const finalStats = this.state.buildFinalStats();
		this.logger.info(
			`Crawl session ended. Stats: ${JSON.stringify(finalStats)}`,
		);
		this.socket.emit("attackEnd", finalStats);
	}
}
