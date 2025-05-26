import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import puppeteer from 'puppeteer';
import sanitizeHtml from 'sanitize-html';
import { existsSync } from 'fs';
import {
  getRobotsRules,
  extractMetadata,
  getChromePaths,
} from '../utils/helpers.js';
import { ContentProcessor } from '../processors/ContentProcessor.js';

// Advanced Crawl Session Class - improved
export class AdvancedCrawlSession {
  constructor(socket, options, dbPromise, logger) {
    this.socket = socket;
    this.dbPromise = dbPromise;
    this.logger = logger;
    this.contentProcessor = new ContentProcessor(logger);

    // Validate and sanitize input options
    this.options = {
      target: options.target,
      crawlDepth: Math.min(Math.max(options.crawlDepth || 2, 1), 5),
      maxPages: Math.min(Math.max(options.maxPages || 50, 1), 200),
      crawlDelay: Math.max(options.crawlDelay || 1000, 500),
      crawlMethod: ['links', 'content', 'media', 'full'].includes(
        options.crawlMethod
      )
        ? options.crawlMethod
        : 'links',
      maxConcurrentRequests: Math.min(
        Math.max(options.maxConcurrentRequests || 5, 1),
        10
      ),
      retryLimit: Math.min(Math.max(options.retryLimit || 3, 0), 5),
      dynamic: options.dynamic !== false, // Default to true
      respectRobots: options.respectRobots !== false, // Default to true
      filterDuplicates: options.filterDuplicates !== false, // Default to true
      saveMedia: ['media', 'full'].includes(options.crawlMethod),
      contentOnly: options.contentOnly || false,
    };

    this.visited = new Set();
    this.queue = [];
    this.domainDelays = new Map();
    this.stats = {
      pagesScanned: 0,
      linksFound: 0,
      totalData: 0, // in KB
      mediaFiles: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0,
    };
    this.startTime = Date.now();
    this.isActive = true;
    this.activeCount = 0;
    this.browser = null;

    // Extract target domain
    try {
      const url = new URL(this.options.target);
      this.targetDomain = url.hostname;
    } catch (e) {
      this.targetDomain = '';
      this.logger.error(`Invalid target URL: ${this.options.target}`);
    }

    // Set up domain crawl delay based on robots.txt (will be filled later)
    this.domainDelays.set(this.targetDomain, this.options.crawlDelay);
  }

  async start() {
    try {
      // If dynamic content is enabled, launch Puppeteer
      if (this.options.dynamic) {
        try {
          const chromePaths = getChromePaths();

          let executablePath = null;

          for (const chromePath of chromePaths) {
            if (existsSync(chromePath)) {
              executablePath = chromePath;
              this.logger.info(`Found Chrome executable at: ${chromePath}`);
              break;
            }
          }

          // Launch options with improved configuration for Docker/Production
          const launchOptions = {
            headless: 'new',
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--disable-software-rasterizer',
              '--disable-background-timer-throttling',
              '--disable-backgrounding-occluded-windows',
              '--disable-renderer-backgrounding',
              '--disable-features=TranslateUI',
              '--disable-ipc-flooding-protection',
              '--window-size=1280,720',
              '--disable-extensions',
              '--disable-features=site-per-process',
              '--no-first-run',
              '--no-zygote',
              '--single-process', // Important for some cloud environments
              '--disable-background-networking',
            ],
          };

          // Add the executable path if we found it
          if (executablePath) {
            launchOptions.executablePath = executablePath;
          }

          this.logger.info(
            `Launching Puppeteer with config: ${JSON.stringify(launchOptions)}`
          );
          this.browser = await puppeteer.launch(launchOptions);
          this.logger.info(
            'Puppeteer launched successfully for dynamic content handling.'
          );
        } catch (err) {
          this.logger.error(`Failed to launch Puppeteer: ${err.message}`);
          // Fall back to static crawling
          this.options.dynamic = false;
          this.socket.emit('stats', {
            ...this.stats,
            log: `⚠️ Falling back to static crawling: ${err.message}`,
          });
        }
      }

      // Check robots.txt first
      if (this.options.respectRobots && this.targetDomain) {
        try {
          const robots = await getRobotsRules(
            this.targetDomain,
            this.dbPromise,
            this.logger
          );

          // Check if we're allowed to crawl the target
          if (!robots.isAllowed(this.options.target, 'MikuCrawler')) {
            this.socket.emit('stats', {
              ...this.stats,
              log: `⚠️ This site doesn't allow crawling according to robots.txt. Respecting their wishes.`,
            });
            this.logger.warn(
              `Robots.txt disallows crawling ${this.options.target}`
            );

            // Store this information
            const db = await this.dbPromise;
            await db.run(
              'INSERT OR REPLACE INTO domain_settings (domain, allowed) VALUES (?, 0)',
              this.targetDomain
            );

            this.stop();
            return;
          }

          // Get crawl delay from robots.txt
          const crawlDelay = robots.getCrawlDelay('MikuCrawler');
          if (crawlDelay) {
            const delayMs = Math.max(
              crawlDelay * 1000,
              this.options.crawlDelay
            );
            this.domainDelays.set(this.targetDomain, delayMs);
            this.logger.info(
              `Using robots.txt crawl delay for ${this.targetDomain}: ${delayMs}ms`
            );
          }
        } catch (err) {
          this.logger.error(`Error checking robots.txt: ${err.message}`);
        }
      }

      // Start with the target
      this.enqueue({ url: this.options.target, depth: 0, retries: 0 });
      this.processQueue();
    } catch (err) {
      this.logger.error(`Error starting crawl: ${err.message}`);
      this.socket.emit('stats', {
        ...this.stats,
        log: `⚠️ Error starting crawler: ${err.message}`,
      });
      this.stop();
    }
  }

  enqueue(item) {
    if (!this.visited.has(item.url)) {
      this.queue.push(item);
      // Log enqueued item for deeper depths
      if (item.depth > 0) {
        this.logger.debug(`Enqueued: ${item.url} at depth ${item.depth}`);
      }
    }
  }

  async processQueue() {
    // Keep track of domains being processed to implement per-domain rate limiting
    const domainProcessing = new Map();

    while ((this.queue.length > 0 || this.activeCount > 0) && this.isActive) {
      // Process as many items as possible up to maxConcurrentRequests
      while (
        this.activeCount < this.options.maxConcurrentRequests &&
        this.queue.length > 0
      ) {
        const item = this.queue.shift();

        try {
          // Get domain of URL
          const url = new URL(item.url);
          const domain = url.hostname;

          // Check if we're already processing this domain and need to respect crawl delay
          const lastProcessed = domainProcessing.get(domain) || 0;
          const now = Date.now();
          const domainDelay =
            this.domainDelays.get(domain) || this.options.crawlDelay;

          if (now - lastProcessed < domainDelay) {
            // Put back in queue and continue with next item
            this.queue.push(item);
            continue;
          }

          // Mark this domain as being processed
          domainProcessing.set(domain, now);

          // Process the item
          this.activeCount++;
          this.fetchPage(item).finally(() => {
            this.activeCount--;
          });
        } catch (err) {
          this.logger.error(`Error in queue processing: ${err.message}`);
          this.activeCount--;
        }
      }

      // Emit live stats periodically
      if (this.activeCount > 0 || this.queue.length > 0) {
        this.socket.volatile.emit('queueStats', {
          activeRequests: this.activeCount,
          queueLength: this.queue.length,
          elapsedTime: Math.floor((Date.now() - this.startTime) / 1000),
          pagesPerSecond:
            this.stats.pagesScanned / ((Date.now() - this.startTime) / 1000),
        });
      }

      // Small pause to prevent CPU hogging
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.isActive) {
      // All done, clean up
      this.stop();
    }
  }

  async fetchPage(item) {
    if (this.stats.pagesScanned >= this.options.maxPages || !this.isActive)
      return;
    if (this.visited.has(item.url)) return;

    let content = '';
    let $;
    let statusCode = 0;
    let contentType = '';
    let contentLength = 0;
    let title = '';
    let description = '';
    let isDynamic = false;
    let lastModified = null;

    try {
      this.logger.info(`Fetching: ${item.url}`);

      // Check if we should use dynamic content fetching (Puppeteer)
      if (this.options.dynamic && this.browser) {
        isDynamic = true;
        const page = await this.browser.newPage();

        // Set user agent to identify our crawler
        await page.setUserAgent(
          'MikuCrawler/1.0 (+https://mikucrawler.example.com)'
        );

        // Set viewport to a reasonable size
        await page.setViewport({ width: 1280, height: 720 });

        // Handle dialogs automatically
        page.on('dialog', async (dialog) => {
          await dialog.dismiss();
        });

        try {
          // Navigation with timeout
          const response = await page.goto(item.url, {
            waitUntil: 'networkidle2',
            timeout: 20000,
          });

          // Extract HTTP status and headers
          statusCode = response.status();
          contentType = response.headers()['content-type'] || '';
          contentLength = parseInt(
            response.headers()['content-length'] || '0',
            10
          );
          lastModified = response.headers()['last-modified'];

          // Set cookies to skip pop-ups (optional)
          try {
            await page.setCookie({
              name: 'cookie_consent',
              value: 'true',
              domain: new URL(item.url).hostname,
            });
          } catch {}

          // Get page content
          content = await page.content();

          // Get page title and description
          title = await page.title();
          description = await page
            .$eval('meta[name="description"]', (el) => el.content)
            .catch(() => '');

          // Optionally take a screenshot
          if (this.options.screenshots) {
            await page.screenshot({
              path: `./data/screenshots/${
                new URL(item.url).hostname
              }_${Date.now()}.png`,
              fullPage: false,
              type: 'jpeg',
              quality: 70,
            });
          }

          await page.close();
        } catch (err) {
          this.logger.error(`Puppeteer error for ${item.url}: ${err.message}`);
          await page.close();
          throw err;
        }
      } else {
        // Use axios for static content
        const response = await axios.get(item.url, {
          timeout: 10000,
          maxContentLength: 5 * 1024 * 1024, // 5MB limit
          headers: {
            'User-Agent': 'MikuCrawler/1.0 (+https://mikucrawler.example.com)',
          },
        });

        content = response.data;
        statusCode = response.status;
        contentType = response.headers['content-type'] || '';
        contentLength = parseInt(response.headers['content-length'] || '0', 10);
        lastModified = response.headers['last-modified'];

        // For HTML content, extract metadata
        if (contentType.includes('text/html')) {
          $ = cheerio.load(content);
          const metadata = extractMetadata($);
          title = metadata.title;
          description = metadata.description;
        }
      }

      // Mark as visited
      this.visited.add(item.url);
      this.stats.pagesScanned++;
      this.stats.successCount++;

      // Calculate content length if not provided in headers
      if (!contentLength && content) {
        contentLength = Buffer.byteLength(content, 'utf8');
      }

      this.stats.totalData += Math.floor(contentLength / 1024); // KB

      // Get domain of URL
      const url = new URL(item.url);
      const domain = url.hostname;

      // Process content with ContentProcessor for enhanced data extraction
      let processedContent;
      try {
        processedContent = await this.contentProcessor.processContent(
          content,
          item.url,
          contentType
        );
      } catch (error) {
        this.logger.error(
          `ContentProcessor failed for ${item.url}: ${error.message}`
        );
        // Provide fallback data
        processedContent = {
          extractedData: { mainContent: '' },
          analysis: {
            wordCount: 0,
            readingTime: 0,
            language: 'unknown',
            keywords: [],
            sentiment: 'neutral',
            readabilityScore: 0,
            quality: { score: 0, factors: {}, issues: ['Processing failed'] },
          },
          metadata: {},
          media: [],
          links: [],
          errors: [{ type: 'processor_error', message: error.message }],
        };
      }

      // Insert into database
      const db = await this.dbPromise;
      const sanitizedContent = contentType.includes('text/html')
        ? sanitizeHtml(content, {
            allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
            allowedAttributes: {
              ...sanitizeHtml.defaults.allowedAttributes,
              '*': ['class', 'id', 'style'],
            },
          })
        : content;

      // Prepare enhanced data for database with safe fallbacks
      const enhancedData = {
        mainContent: processedContent.extractedData?.mainContent || '',
        wordCount: processedContent.analysis?.wordCount || 0,
        readingTime: processedContent.analysis?.readingTime || 0,
        language: processedContent.analysis?.language || 'unknown',
        keywords: JSON.stringify(processedContent.analysis?.keywords || []),
        qualityScore: processedContent.analysis?.quality?.score || 0,
        structuredData: JSON.stringify(processedContent.extractedData || {}),
        mediaCount: processedContent.media?.length || 0,
        internalLinksCount:
          processedContent.links?.filter((link) => link.isInternal)?.length ||
          0,
        externalLinksCount:
          processedContent.links?.filter((link) => !link.isInternal)?.length ||
          0,
      };

      const result = await db.run(
        `INSERT OR REPLACE INTO pages
        (url, domain, content_type, status_code, data_length, title, description, content, is_dynamic, last_modified,
         main_content, word_count, reading_time, language, keywords, quality_score, structured_data,
         media_count, internal_links_count, external_links_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        item.url,
        domain,
        contentType,
        statusCode,
        contentLength,
        title,
        description,
        this.options.contentOnly ? null : sanitizedContent, // Save content only if needed
        isDynamic ? 1 : 0,
        lastModified,
        enhancedData.mainContent,
        enhancedData.wordCount,
        enhancedData.readingTime,
        enhancedData.language,
        enhancedData.keywords,
        enhancedData.qualityScore,
        enhancedData.structuredData,
        enhancedData.mediaCount,
        enhancedData.internalLinksCount,
        enhancedData.externalLinksCount
      );

      // Parse content and extract links if HTML
      let links = [];
      if (contentType.includes('text/html')) {
        // If $ is not already defined from axios flow, load it now
        if (!$) {
          $ = cheerio.load(content);
        }

        links = this.extractLinks($, item.url);
        this.stats.linksFound += links.length;

        // Store links in database
        if (links.length > 0 && result.lastID) {
          const sourceId = result.lastID;
          const linkInsertPromises = links.map((link) => {
            return db
              .run(
                'INSERT OR IGNORE INTO links (source_id, target_url, text) VALUES (?, ?, ?)',
                sourceId,
                link.url,
                link.text || ''
              )
              .catch((err) => {
                this.logger.warn(`Failed to insert link: ${err.message}`);
              });
          });

          await Promise.allSettled(linkInsertPromises);
        }
      }

      // Handle media files if this crawl method includes them
      if (
        (this.options.crawlMethod === 'media' ||
          this.options.crawlMethod === 'full') &&
        contentType.match(/image|video|audio|application\/(pdf|zip)/i)
      ) {
        this.stats.mediaFiles++;
      }

      // Emit stats update to client with enhanced insights
      const enhancedLog = [
        `🕷️ Crawled: ${item.url} (${statusCode})`,
        `[${Math.floor(contentLength / 1024)}KB]`,
        processedContent.analysis?.wordCount
          ? `${processedContent.analysis.wordCount} words`
          : '',
        processedContent.analysis?.language &&
        processedContent.analysis.language !== 'unknown'
          ? `Lang: ${processedContent.analysis.language}`
          : '',
        processedContent.analysis?.quality?.score
          ? `Quality: ${processedContent.analysis.quality.score}/100`
          : '',
        processedContent.links?.length
          ? `${processedContent.links.length} links`
          : '',
        processedContent.media?.length
          ? `${processedContent.media.length} media`
          : '',
      ]
        .filter(Boolean)
        .join(' | ');

      this.socket.emit('stats', {
        ...this.stats,
        log: enhancedLog,
        // Add processing insights to stats
        lastProcessed: {
          url: item.url,
          wordCount: processedContent.analysis?.wordCount || 0,
          qualityScore: processedContent.analysis?.quality?.score || 0,
          language: processedContent.analysis?.language || 'unknown',
          mediaCount: processedContent.media?.length || 0,
          linksCount: processedContent.links?.length || 0,
        },
      });

      // Emit page content to client with enhanced processed data
      const pageForClient = {
        url: item.url,
        content: sanitizedContent,
        title,
        description,
        contentType,
        domain,
        // Enhanced data from ContentProcessor
        processedData: {
          extractedData: processedContent.extractedData || {},
          metadata: processedContent.metadata || {},
          analysis: processedContent.analysis || {},
          media: processedContent.media || [],
          qualityScore: processedContent.analysis?.quality?.score || 0,
          keywords: processedContent.analysis?.keywords || [],
          language: processedContent.analysis?.language || 'unknown',
        },
      };

      this.socket.emit('pageContent', pageForClient);

      // Enqueue more links if we haven't reached depth limit
      if (item.depth < this.options.crawlDepth - 1) {
        // Filter links to process
        const linksToProcess = links.filter(
          (link) => !this.visited.has(link.url)
        );

        // Check for robots.txt before enqueuing
        if (this.options.respectRobots) {
          for (const link of linksToProcess) {
            try {
              const linkUrl = new URL(link.url);
              const linkDomain = linkUrl.hostname;

              // Only check robots.txt for new domains
              if (linkDomain !== domain && linkDomain !== this.targetDomain) {
                const robots = await getRobotsRules(
                  linkDomain,
                  this.dbPromise,
                  this.logger
                );

                if (!robots.isAllowed(link.url, 'MikuCrawler')) {
                  this.logger.debug(
                    `Skipping ${link.url} - disallowed by robots.txt`
                  );
                  this.stats.skippedCount++;
                  continue;
                }

                // Get crawl delay for this domain
                const crawlDelay = robots.getCrawlDelay('MikuCrawler');
                if (crawlDelay) {
                  const delayMs = Math.max(
                    crawlDelay * 1000,
                    this.options.crawlDelay
                  );
                  this.domainDelays.set(linkDomain, delayMs);
                } else {
                  this.domainDelays.set(linkDomain, this.options.crawlDelay);
                }
              }

              this.enqueue({
                url: link.url,
                depth: item.depth + 1,
                retries: 0,
                parentUrl: item.url,
              });
            } catch (err) {
              this.logger.debug(
                `Error processing link ${link.url}: ${err.message}`
              );
            }
          }
        } else {
          // Just enqueue all links without checking robots.txt
          linksToProcess.forEach((link) => {
            this.enqueue({
              url: link.url,
              depth: item.depth + 1,
              retries: 0,
              parentUrl: item.url,
            });
          });
        }
      }

      // Crawl delay - use the domain-specific delay
      const domainDelay =
        this.domainDelays.get(domain) || this.options.crawlDelay;
      await new Promise((r) => setTimeout(r, domainDelay));
    } catch (err) {
      this.stats.failureCount++;
      this.logger.error(`Error crawling ${item.url}: ${err.message}`);

      this.socket.emit('stats', {
        ...this.stats,
        log: `⚠️ Error crawling ${item.url}: ${err.message}`,
      });

      // Retry logic with exponential backoff
      if (item.retries < this.options.retryLimit) {
        item.retries++;
        const backoffDelay = Math.min(1000 * Math.pow(2, item.retries), 30000); // Max 30s
        this.logger.info(
          `Retrying ${item.url} in ${backoffDelay}ms (attempt ${item.retries}/${this.options.retryLimit})`
        );

        setTimeout(() => {
          this.enqueue(item);
        }, backoffDelay);
      } else {
        this.visited.add(item.url); // Mark as visited to avoid further attempts
      }
    }
  }

  extractLinks($, baseUrl) {
    const links = new Set();
    const baseHost = new URL(baseUrl).hostname;
    const seen = new Set();
    const result = [];

    // Extract all links from anchor tags
    $('a').each((_, el) => {
      let href = $(el).attr('href');
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
        result.push({
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
          result.push({
            url: url.href,
            text: $(el).attr('alt') || '',
          });
        } catch (e) {
          // Ignore invalid URLs
        }
      });
    }

    return result.slice(0, 200); // Limit to 200 links per page
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
