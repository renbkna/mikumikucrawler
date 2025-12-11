import { URL } from "node:url";
import type Database from "better-sqlite3";
import type { Socket } from "socket.io";
import type { Logger } from "winston";
import type { QueueItem, SanitizedCrawlOptions } from "../types.js";
import { getRobotsRules } from "../utils/helpers.js";
import { DynamicRenderer } from "./dynamicRenderer.js";
import { CrawlQueue } from "./modules/crawlQueue.js";
import { CrawlState } from "./modules/crawlState.js";
import { createPagePipeline } from "./modules/pagePipeline.js";

export class AdvancedCrawlSession {
	private readonly socket: Socket;
	private readonly dbPromise: Promise<Database.Database>;
	private readonly logger: Logger;
	private readonly options: SanitizedCrawlOptions;
	private readonly state: CrawlState;
	private readonly dynamicRenderer: DynamicRenderer;
	private readonly targetDomain: string;
	private readonly queue: CrawlQueue;
	private readonly pipeline: (item: QueueItem) => Promise<void>;

	constructor(
		socket: Socket,
		options: SanitizedCrawlOptions,
		dbPromise: Promise<Database.Database>,
		logger: Logger,
	) {
		this.socket = socket;
		this.dbPromise = dbPromise;
		this.logger = logger;

		// Options are already validated by sanitizeOptions in socketHandlers.ts
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
			filterDuplicates: options.filterDuplicates !== false,
			saveMedia: options.saveMedia,
			contentOnly: options.contentOnly,
		};

		this.state = new CrawlState(this.options);
		this.dynamicRenderer = new DynamicRenderer(this.options, this.logger);

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
			dbPromise: this.dbPromise,
			dynamicRenderer: this.dynamicRenderer,
			queue: this.queue,
			targetDomain: this.targetDomain,
		});

		this.queue.processItem = this.pipeline;
	}

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
						this.dbPromise,
						this.logger,
					);

					if (robots && !robots.isAllowed(this.options.target, "MikuCrawler")) {
						this.socket.emit("stats", {
							...this.state.stats,
							log: `[Crawler] Robots.txt disallows crawling this target; stopping.`,
						});
						this.logger.warn(
							`Robots.txt disallows crawling ${this.options.target}`,
						);

						const db = await this.dbPromise;
						db.prepare(
							"INSERT OR REPLACE INTO domain_settings (domain, allowed) VALUES (?, 0)",
						).run(this.targetDomain);

						await this.stop();
						return;
					}

					const crawlDelay = robots?.getCrawlDelay?.("MikuCrawler");
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
					const message = err instanceof Error ? err.message : "Unknown error";
					this.logger.error(`Error checking robots.txt: ${message}`);
				}
			}

			this.queue.enqueue({ url: this.options.target, depth: 0, retries: 0 });
			this.queue.start();
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			this.logger.error(`Error starting crawl: ${message}`);
			this.socket.emit("stats", {
				...this.state.stats,
				log: `[Crawler] Error starting crawler: ${message}`,
			});
			await this.stop();
		}
	}

	async stop(): Promise<void> {
		if (!this.state.isActive) {
			return;
		}

		this.state.stop();
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
