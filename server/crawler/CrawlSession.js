import { URL } from "url";
import { getRobotsRules } from "../utils/helpers.js";
import { DynamicRenderer } from "./dynamicRenderer.js";
import { CrawlQueue } from "./modules/crawlQueue.js";
import { CrawlState } from "./modules/crawlState.js";
import { createPagePipeline } from "./modules/pagePipeline.js";

export class AdvancedCrawlSession {
  constructor(socket, options, dbPromise, logger) {
    this.socket = socket;
    this.dbPromise = dbPromise;
    this.logger = logger;

    this.options = {
      target: options.target,
      crawlDepth: Math.min(Math.max(options.crawlDepth || 2, 1), 5),
      maxPages: Math.min(Math.max(options.maxPages || 50, 1), 200),
      crawlDelay: Math.max(options.crawlDelay || 1000, 500),
      crawlMethod: ["links", "content", "media", "full"].includes(options.crawlMethod)
        ? options.crawlMethod
        : "links",
      maxConcurrentRequests: Math.min(
        Math.max(options.maxConcurrentRequests || 5, 1),
        10
      ),
      retryLimit: Math.min(Math.max(options.retryLimit || 3, 0), 5),
      dynamic: options.dynamic !== false,
      respectRobots: options.respectRobots !== false,
      filterDuplicates: options.filterDuplicates !== false,
      saveMedia:
        typeof options.saveMedia === 'boolean'
          ? options.saveMedia
          : ["media", "full"].includes(options.crawlMethod),
      contentOnly: options.contentOnly || false,
    };

    this.state = new CrawlState(this.options);
    this.dynamicRenderer = new DynamicRenderer(this.options, this.logger);

    this.targetDomain = "";
    try {
      const url = new URL(this.options.target);
      this.targetDomain = url.hostname;
    } catch (error) {
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

  async start() {
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
            this.logger
          );

          if (robots && !robots.isAllowed(this.options.target, "MikuCrawler")) {
            this.socket.emit("stats", {
              ...this.state.stats,
              log: `[Crawler] Robots.txt disallows crawling this target; stopping.`,
            });
            this.logger.warn(
              `Robots.txt disallows crawling ${this.options.target}`
            );

            const db = await this.dbPromise;
            db.prepare(
              "INSERT OR REPLACE INTO domain_settings (domain, allowed) VALUES (?, 0)"
            ).run(this.targetDomain);

            await this.stop();
            return;
          }

          const crawlDelay = robots?.getCrawlDelay?.("MikuCrawler");
          if (crawlDelay) {
            const delayMs = Math.max(crawlDelay * 1000, this.options.crawlDelay);
            this.state.setDomainDelay(this.targetDomain, delayMs);
            this.logger.info(
              `Using robots.txt crawl delay for ${this.targetDomain}: ${delayMs}ms`
            );
          }
        } catch (err) {
          this.logger.error(`Error checking robots.txt: ${err.message}`);
        }
      }

      this.queue.enqueue({ url: this.options.target, depth: 0, retries: 0 });
      this.queue.start();
    } catch (err) {
      this.logger.error(`Error starting crawl: ${err.message}`);
      this.socket.emit("stats", {
        ...this.state.stats,
        log: `[Crawler] Error starting crawler: ${err.message}`,
      });
      await this.stop();
    }
  }

  async stop() {
    if (!this.state.isActive) {
      return;
    }

    this.state.stop();
    this.queue.clearRetries();
    await this.queue.awaitIdle();
    await this.dynamicRenderer.close();

    const finalStats = this.state.buildFinalStats();
    this.logger.info(
      `Crawl session ended. Stats: ${JSON.stringify(finalStats)}`
    );
    this.socket.emit("attackEnd", finalStats);
  }
}
