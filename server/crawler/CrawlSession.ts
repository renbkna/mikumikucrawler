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
import {
	loadPendingQueueItems,
	loadSession,
	saveSession,
	updateSessionStatus,
} from "../utils/sessionPersistence.js";
import { fetchSitemap } from "../utils/sitemapParser.js";
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
	private pipeline!: (item: QueueItem) => Promise<void>;
	private stopPromise: Promise<void> | null = null;
	/** Unique ID for this session — used to persist queue state to DB for resume support. */
	readonly sessionId: string;
	/** Whether this is a resumed session (skips robots.txt + sitemap re-discovery) */
	private readonly isResumed: boolean;

	constructor(
		socket: CrawlerSocket,
		options: SanitizedCrawlOptions,
		db: Database,
		logger: Logger,
		sessionId?: string,
		isResumed = false,
	) {
		this.sessionId = sessionId ?? crypto.randomUUID();
		this.isResumed = isResumed;
		this.socket = socket;
		this.db = db;
		this.logger = logger;

		this.options = {
			target: options.target,
			crawlDepth: options.crawlDepth,
			maxPages: options.maxPages,
			maxPagesPerDomain: options.maxPagesPerDomain,
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
			sessionId: this.sessionId,
			db: this.db,
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
			sessionId: this.sessionId,
		});

		// Use per-session request coalescing to prevent duplicate simultaneous
		// fetches of the same URL within this session. Unlike a global coalescer,
		// this does NOT share results across different user sessions.
		this.queue.processItem = async (item: QueueItem) => {
			await this.coalescer.coalesce(item.url, () => this.pipeline(item));
		};
	}

	async start(): Promise<void> {
		saveSession(this.db, this.sessionId, this.socket.id, this.options);

		try {
			const initResult = await this.dynamicRenderer.initialize();
			if (!initResult.dynamicEnabled && initResult.fallbackLog) {
				this.socket.emit("stats", {
					...this.state.stats,
					log: initResult.fallbackLog,
				});
			}

			if (!this.isResumed && this.options.respectRobots && this.targetDomain) {
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

			if (!this.isResumed) {
				if (this.options.crawlMethod === "full") {
					const sitemapEntries = await fetchSitemap(
						this.options.target,
						this.logger,
					);
					if (sitemapEntries.length > 0) {
						this.socket.emit("stats", {
							...this.state.stats,
							log: `[Sitemap] Found ${sitemapEntries.length} URLs`,
						});
						for (const entry of sitemapEntries) {
							this.queue.enqueue({ url: entry.url, depth: 0, retries: 0 });
						}
					}
				}
				this.queue.enqueue({ url: this.options.target, depth: 0, retries: 0 });
			} else {
				const alreadyCrawled = this.db.query("SELECT url FROM pages").all() as {
					url: string;
				}[];
				for (const row of alreadyCrawled) {
					this.state.markVisited(row.url);
				}
				this.logger.info(
					`[Resume] Pre-seeded ${alreadyCrawled.length} visited URLs from DB`,
				);

				const pendingItems = loadPendingQueueItems(this.db, this.sessionId);
				this.logger.info(
					`[Resume] Seeding ${pendingItems.length} pending URLs`,
				);
				this.socket.emit("stats", {
					...this.state.stats,
					log: `[Resume] Continuing with ${pendingItems.length} pending URLs`,
				});
				for (const pending of pendingItems) {
					this.queue.enqueue(pending);
				}
			}
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

	stop(): Promise<void> {
		if (this.stopPromise) {
			return this.stopPromise;
		}

		if (!this.state.isActive) {
			return Promise.resolve();
		}

		this.state.stop();
		this.stopPromise = this._teardown();
		return this.stopPromise;
	}

	private async _teardown(): Promise<void> {
		this.queue.clearRetries();
		await this.queue.awaitIdle();
		await this.dynamicRenderer.close();

		updateSessionStatus(this.db, this.sessionId, "completed");

		const finalStats = this.state.buildFinalStats();
		this.logger.info(
			`Crawl session ended. Stats: ${JSON.stringify(finalStats)}`,
		);
		this.socket.emit("attackEnd", finalStats);
	}

	interrupt(): void {
		if (this.state.isActive) {
			this.state.stop();
		}
		this.queue.clearRetries();
		this.queue.flushPersistBuffer();
		updateSessionStatus(this.db, this.sessionId, "interrupted");
		this.dynamicRenderer.close().catch(() => {});
	}

	static resume(
		sessionId: string,
		socket: CrawlerSocket,
		db: Database,
		logger: Logger,
	): CrawlSession | null {
		const stored = loadSession(db, sessionId);
		if (!stored) {
			logger.warn(`[Resume] Session ${sessionId} not found`);
			return null;
		}
		if (stored.status !== "interrupted") {
			logger.warn(
				`[Resume] Session ${sessionId} is not interrupted (status: ${stored.status})`,
			);
			return null;
		}

		const session = new CrawlSession(
			socket,
			stored.options,
			db,
			logger,
			sessionId,
			true,
		);
		db.query(
			"UPDATE crawl_sessions SET socket_id = ?, status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		).run(socket.id, sessionId);

		return session;
	}
}
