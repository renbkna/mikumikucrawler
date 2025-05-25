import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import puppeteer from 'puppeteer';
import { getRobotsRules } from '../utils/robots.js';
import { extractMetadata } from '../utils/metadata.js';

export class AdvancedCrawlSession {
  constructor(socket, options, dbPromise, logger) {
    this.socket = socket;
    this.options = options;
    this.dbPromise = dbPromise;
    this.logger = logger;
    this.isActive = false;
    this.queue = [];
    this.visited = new Set();
    this.processing = new Set();
    this.stats = {
      pagesScanned: 0,
      successCount: 0,
      errorCount: 0,
      queueSize: 0,
      currentDepth: 0,
    };
    this.startTime = null;
    this.browser = null;
    this.domainLimits = new Map();
  }

  async start() {
    if (this.isActive) return;

    this.isActive = true;
    this.startTime = Date.now();
    this.logger.info(
      `Starting crawl session for target: ${this.options.target}`
    );

    try {
      // Validate target URL
      const targetUrl = new URL(this.options.target);

      // Initialize browser if dynamic crawling is enabled
      if (this.options.dynamic) {
        await this.initializeBrowser();
      }

      // Add initial URL to queue
      this.enqueue({
        url: targetUrl.href,
        depth: 0,
        referrer: null,
      });

      // Start processing
      await this.processQueue();
    } catch (error) {
      this.logger.error(`Error starting crawl session: ${error.message}`);
      this.socket.emit('error', { message: error.message });
      await this.stop();
    }
  }

  async initializeBrowser() {
    const isProd = process.env.NODE_ENV === 'production';

    this.browser = await puppeteer.launch({
      headless: true,
      args: isProd
        ? [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
          ]
        : [],
    });

    this.logger.info('Puppeteer browser initialized');
  }

  enqueue(item) {
    if (this.visited.has(item.url) || this.processing.has(item.url)) {
      return false;
    }

    if (this.queue.length >= 10000) {
      return false; // Queue size limit
    }

    this.queue.push(item);
    this.stats.queueSize = this.queue.length;
    return true;
  }

  async processQueue() {
    const maxConcurrent = this.options.maxConcurrentRequests || 3;
    const promises = [];

    while (this.isActive && (this.queue.length > 0 || promises.length > 0)) {
      // Start new requests up to the concurrent limit
      while (
        promises.length < maxConcurrent &&
        this.queue.length > 0 &&
        this.isActive
      ) {
        const item = this.queue.shift();
        this.stats.queueSize = this.queue.length;

        if (!this.visited.has(item.url) && !this.processing.has(item.url)) {
          this.processing.add(item.url);
          const promise = this.fetchPage(item).finally(() => {
            this.processing.delete(item.url);
          });
          promises.push(promise);
        }
      }

      // Wait for at least one request to complete
      if (promises.length > 0) {
        await Promise.race(promises);
        // Remove completed promises
        for (let i = promises.length - 1; i >= 0; i--) {
          if (promises[i].isResolved !== false) {
            promises.splice(i, 1);
          }
        }
      }

      // Emit stats update
      this.socket.emit('attackProgress', this.stats);

      // Check limits
      if (this.stats.pagesScanned >= this.options.maxPages) {
        this.logger.info('Max pages limit reached');
        break;
      }

      // Add delay between batches
      if (this.options.crawlDelay > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.crawlDelay)
        );
      }
    }

    // Wait for all remaining promises to complete
    await Promise.allSettled(promises);

    if (this.isActive) {
      await this.stop();
    }
  }

  async fetchPage(item) {
    if (!this.isActive) return;

    try {
      this.visited.add(item.url);
      this.stats.currentDepth = Math.max(this.stats.currentDepth, item.depth);

      const url = new URL(item.url);
      const domain = url.hostname;

      // Check robots.txt if enabled
      if (this.options.respectRobots) {
        const robots = await getRobotsRules(domain, this.dbPromise);
        if (!robots.isAllowed(item.url, '*')) {
          this.logger.info(`Robots.txt disallows: ${item.url}`);
          return;
        }
      }

      // Domain-specific rate limiting
      await this.respectDomainLimits(domain);

      let response, $, contentType, statusCode, dataLength;

      if (this.options.dynamic && this.browser) {
        // Use Puppeteer for dynamic content
        const result = await this.fetchWithPuppeteer(item.url);
        response = result.content;
        $ = cheerio.load(response);
        contentType = 'text/html';
        statusCode = result.statusCode;
        dataLength = response.length;
      } else {
        // Use Axios for static content
        const axiosResponse = await axios.get(item.url, {
          timeout: 30000,
          maxRedirects: 5,
          headers: {
            'User-Agent':
              'MikuCrawler/1.0 (+https://github.com/yourusername/mikumikucrawler)',
          },
        });

        response = axiosResponse.data;
        $ = cheerio.load(response);
        contentType = axiosResponse.headers['content-type'] || 'text/html';
        statusCode = axiosResponse.status;
        dataLength = response.length;
      }

      // Extract metadata
      const metadata = extractMetadata($);

      // Store in database
      const db = await this.dbPromise;
      const result = await db.run(
        `INSERT OR REPLACE INTO pages
         (url, domain, content_type, status_code, data_length, title, description, content, is_dynamic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        item.url,
        domain,
        contentType,
        statusCode,
        dataLength,
        metadata.title,
        metadata.description,
        this.options.contentOnly ? '' : metadata.content,
        this.options.dynamic ? 1 : 0
      );

      const pageId = result.lastID;

      // Extract and process links
      if (item.depth < this.options.crawlDepth) {
        const links = this.extractLinks($, item.url);

        // Store links in database
        for (const link of links) {
          await db.run(
            `INSERT OR IGNORE INTO links (source_id, target_url, text) VALUES (?, ?, ?)`,
            pageId,
            link.url,
            link.text
          );

          // Add to queue for further crawling
          this.enqueue({
            url: link.url,
            depth: item.depth + 1,
            referrer: item.url,
          });
        }
      }

      this.stats.pagesScanned++;
      this.stats.successCount++;

      // Emit page data
      this.socket.emit('pageFound', {
        url: item.url,
        title: metadata.title,
        statusCode,
        depth: item.depth,
        dataLength,
      });

      this.logger.info(`Successfully crawled: ${item.url}`);
    } catch (error) {
      this.stats.errorCount++;
      this.logger.error(`Error crawling ${item.url}: ${error.message}`);

      this.socket.emit('error', {
        url: item.url,
        message: error.message,
      });
    }
  }

  async fetchWithPuppeteer(url) {
    const page = await this.browser.newPage();

    try {
      await page.setUserAgent(
        'MikuCrawler/1.0 (+https://github.com/yourusername/mikumikucrawler)'
      );

      const response = await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: 30000,
      });

      const content = await page.content();
      const statusCode = response.status();

      return { content, statusCode };
    } finally {
      await page.close();
    }
  }

  async respectDomainLimits(domain) {
    const now = Date.now();
    const lastRequest = this.domainLimits.get(domain) || 0;
    const delay = Math.max(0, 1000 - (now - lastRequest)); // 1 second minimum delay

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.domainLimits.set(domain, Date.now());
  }

  extractLinks($, baseUrl) {
    const links = [];
    const seen = new Set();
    const baseHost = new URL(baseUrl).hostname;

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      try {
        const url = new URL(href, baseUrl);

        // Normalize URL by removing fragments and trailing slashes
        let normalizedUrl = url.href.split('#')[0];
        if (normalizedUrl.endsWith('/')) {
          normalizedUrl = normalizedUrl.slice(0, -1);
        }

        // Skip already seen URLs
        if (seen.has(normalizedUrl)) return;
        seen.add(normalizedUrl);

        // Skip non-HTTP protocols
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

        // If crawling the same domain only
        if (this.options.crawlMethod !== 'full' && url.hostname !== baseHost)
          return;

        // Skip common non-content URLs
        if (
          url.pathname.match(
            /\.(css|js|json|xml|txt|md|csv|svg|ico|git|gitignore)$/i
          )
        )
          return;

        // Add link with text
        links.push({
          url: url.href,
          text: $(el).text().trim(),
        });
      } catch (e) {
        // Ignore invalid URLs
      }
    });

    // Extract media links if configured to do so
    if (
      this.options.crawlMethod === 'media' ||
      this.options.crawlMethod === 'full'
    ) {
      $('img, video, audio, source').each((_, el) => {
        let src = $(el).attr('src');
        if (!src) return;

        try {
          const url = new URL(src, baseUrl);
          const normalizedUrl = url.href.split('#')[0];

          if (seen.has(normalizedUrl)) return;
          seen.add(normalizedUrl);

          if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

          // For media, we can allow external domains
          links.push({
            url: url.href,
            text: $(el).attr('alt') || '',
          });
        } catch (e) {
          // Ignore invalid URLs
        }
      });
    }

    return links.slice(0, 200); // Limit to 200 links per page
  }

  async stop() {
    if (!this.isActive) return;

    this.isActive = false;

    // Calculate elapsed time
    const elapsedSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const elapsedTime = {
      hours: Math.floor(elapsedSeconds / 3600),
      minutes: Math.floor((elapsedSeconds % 3600) / 60),
      seconds: elapsedSeconds % 60,
    };

    // Additional stats
    const finalStats = {
      ...this.stats,
      elapsedTime,
      pagesPerSecond: elapsedSeconds
        ? (this.stats.pagesScanned / elapsedSeconds).toFixed(2)
        : 0,
      successRate: this.stats.pagesScanned
        ? ((this.stats.successCount / this.stats.pagesScanned) * 100).toFixed(
            1
          ) + '%'
        : '0%',
    };

    if (this.browser) {
      try {
        await this.browser.close();
        this.logger.info('Puppeteer closed.');
      } catch (err) {
        this.logger.error(`Error closing browser: ${err.message}`);
      }
    }

    this.logger.info(
      `Crawl session ended. Stats: ${JSON.stringify(finalStats)}`
    );
    this.socket.emit('attackEnd', finalStats);
  }
}
