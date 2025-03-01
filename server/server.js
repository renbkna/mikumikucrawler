import dotenv from 'dotenv'
dotenv.config()
import express from 'express'
import http from 'http'
import {Server} from 'socket.io'
import axios from 'axios'
import * as cheerio from 'cheerio'
import cors from 'cors'
import {URL} from 'url'
import rateLimit from 'express-rate-limit'
import puppeteer from 'puppeteer'
import winston from 'winston'
import sqlite3 from 'sqlite3'
import {open} from 'sqlite'
import robotsParser from 'robots-parser' // Added for robots.txt handling
import {mkdir, existsSync} from 'fs'
import {promisify} from 'util'
import path from 'path'
import os from 'os' // Added this import
import sanitizeHtml from 'sanitize-html' // For content sanitization

// Configure Puppeteer - Fix for rendering environments like Render.com
const isProd = process.env.NODE_ENV === 'production';

// Promisify mkdir
const mkdirAsync = promisify(mkdir)

// Ensure directories exist
const ensureDirectoryExists = async dir => {
  if (!existsSync(dir)) {
    await mkdirAsync(dir, {recursive: true})
  }
}

// SETUP: Logging (Winston) - improved with daily rotation and better formatting
const setupLogging = async () => {
  await ensureDirectoryExists('./logs')

  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({stack: true}),
      winston.format.splat(),
      winston.format.json()
    ),
    defaultMeta: {service: 'miku-crawler'},
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({timestamp, level, message, ...rest}) => {
            return `${timestamp} ${level}: ${message} ${
              Object.keys(rest).length ? JSON.stringify(rest, null, 2) : ''
            }`
          })
        )
      }),
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error',
        maxsize: 10485760, // 10MB
        maxFiles: 5
      }),
      new winston.transports.File({
        filename: 'logs/crawler.log',
        maxsize: 10485760, // 10MB
        maxFiles: 10
      })
    ]
  })
}

const logger = await setupLogging()

// SETUP: Persistent Storage (SQLite) with improved schema
const setupDatabase = async () => {
  await ensureDirectoryExists('./data')

  const db = await open({
    filename: './data/crawler.db',
    driver: sqlite3.Database
  })

  // Enable WAL mode for better concurrency
  await db.exec('PRAGMA journal_mode = WAL;')
  await db.exec('PRAGMA synchronous = NORMAL;')

  // Create tables with better schema and indexes
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE,
      domain TEXT,
      crawled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_modified TEXT,
      content_type TEXT,
      status_code INTEGER,
      data_length INTEGER,
      title TEXT,
      description TEXT,
      content TEXT,
      is_dynamic BOOLEAN DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER,
      target_url TEXT,
      text TEXT,
      FOREIGN KEY (source_id) REFERENCES pages(id),
      UNIQUE(source_id, target_url)
    );
    
    CREATE TABLE IF NOT EXISTS domain_settings (
      domain TEXT PRIMARY KEY,
      robots_txt TEXT,
      crawl_delay INTEGER DEFAULT 1000,
      last_crawled DATETIME,
      allowed BOOLEAN DEFAULT 1
    );
    
    CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain);
    CREATE INDEX IF NOT EXISTS idx_pages_crawled_at ON pages(crawled_at);
    CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
    CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_url);
  `)

  return db
}

const dbPromise = setupDatabase()

// Domain-specific rate limiting
const domainLimits = new Map()

// Robots.txt cache
const robotsCache = new Map()

// SETUP: Express, HTTP & Socket.IO
const app = express()
const server = http.createServer(app)
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ['GET', 'POST'],
    credentials: true
  },
  maxHttpBufferSize: 5e6, // 5MB
  pingTimeout: 60000
})

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true
  })
)
app.use(express.json({limit: '2mb'}))
app.use(express.urlencoded({extended: true, limit: '2mb'}))

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {error: 'Too many requests, please try again later.'}
})
app.use(globalLimiter)

// Helper function to get robots.txt rules
async function getRobotsRules(domain) {
  if (robotsCache.has(domain)) {
    return robotsCache.get(domain)
  }

  try {
    const db = await dbPromise
    const domainSettings = await db.get(
      'SELECT robots_txt FROM domain_settings WHERE domain = ?',
      domain
    )

    if (domainSettings && domainSettings.robots_txt) {
      const robots = robotsParser(
        `http://${domain}/robots.txt`,
        domainSettings.robots_txt
      )
      robotsCache.set(domain, robots)
      return robots
    }

    const response = await axios.get(`http://${domain}/robots.txt`, {
      timeout: 5000,
      maxRedirects: 3
    })

    const robotsTxt = response.data
    const robots = robotsParser(`http://${domain}/robots.txt`, robotsTxt)

    await db.run(
      'INSERT OR REPLACE INTO domain_settings (domain, robots_txt) VALUES (?, ?)',
      domain,
      robotsTxt
    )

    robotsCache.set(domain, robots)
    return robots
  } catch (err) {
    logger.warn(`Failed to get robots.txt for ${domain}: ${err.message}`)
    // Create an empty robots parser as fallback
    const robots = robotsParser(`http://${domain}/robots.txt`, '')
    robotsCache.set(domain, robots)
    return robots
  }
}

// Helper function to extract metadata from HTML
function extractMetadata($) {
  const title = $('title').text().trim() || ''

  // Extract description from meta tags
  let description = ''
  $('meta[name="description"]').each((_, el) => {
    description = $(el).attr('content') || ''
  })
  if (!description) {
    $('meta[property="og:description"]').each((_, el) => {
      description = $(el).attr('content') || ''
    })
  }

  return {title, description}
}

// Advanced Crawl Session Class - improved
class AdvancedCrawlSession {
  constructor(socket, options) {
    this.socket = socket
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
      contentOnly: options.contentOnly || false
    }

    this.visited = new Set()
    this.queue = []
    this.domainDelays = new Map()
    this.stats = {
      pagesScanned: 0,
      linksFound: 0,
      totalData: 0, // in KB
      mediaFiles: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0
    }
    this.startTime = Date.now()
    this.isActive = true
    this.activeCount = 0
    this.browser = null

    // Extract target domain
    try {
      const url = new URL(this.options.target)
      this.targetDomain = url.hostname
    } catch (e) {
      this.targetDomain = ''
      logger.error(`Invalid target URL: ${this.options.target}`)
    }

    // Set up domain crawl delay based on robots.txt (will be filled later)
    this.domainDelays.set(this.targetDomain, this.options.crawlDelay)
  }

  async start() {
    try {
      // If dynamic content is enabled, launch Puppeteer
      if (this.options.dynamic) {
        try {
          // Common Chrome paths on Render.com - explicitly checking these locations
          // For Render.com, Chrome is typically installed in the /tmp directory by the postinstall script
          const potentialChromePaths = [
            // First priority: Chrome installed by the postinstall script (puppeteer browsers install chrome)
            '/tmp/puppeteer/chrome/linux-133.0.6943.126/chrome-linux64/chrome',
            '/tmp/.cache/puppeteer/chrome/linux-133.0.6943.126/chrome-linux64/chrome',
            '/app/.cache/puppeteer/chrome/linux-133.0.6943.126/chrome-linux64/chrome',
            // Fallback paths
            process.env.PUPPETEER_EXECUTABLE_PATH,
            '/opt/render/project/chrome-linux/chrome',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser'
          ].filter(Boolean); // Filter out undefined/null paths
          
          let executablePath = null;
          
          for (const chromePath of potentialChromePaths) {
            if (existsSync(chromePath)) {
              executablePath = chromePath;
              logger.info(`Found Chrome executable at: ${chromePath}`);
              break;
            }
          }
          
          // Launch options with improved configuration
          const launchOptions = {
            headless: 'new',
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--window-size=1280,720',
              '--disable-extensions',
              '--disable-features=site-per-process'
            ]
          };
          
          // Add the executable path if we found it
          if (executablePath) {
            launchOptions.executablePath = executablePath;
          }
          
          logger.info(`Launching Puppeteer with config: ${JSON.stringify(launchOptions)}`);
          this.browser = await puppeteer.launch(launchOptions);
          logger.info('Puppeteer launched successfully for dynamic content handling.');
        } catch (err) {
          logger.error(`Failed to launch Puppeteer: ${err.message}`);
          // Fall back to static crawling
          this.options.dynamic = false;
          this.socket.emit('stats', {
            ...this.stats,
            log: `⚠️ Falling back to static crawling: ${err.message}`
          });
        }
      }

      // Check robots.txt first
      if (this.options.respectRobots && this.targetDomain) {
        try {
          const robots = await getRobotsRules(this.targetDomain)

          // Check if we're allowed to crawl the target
          if (!robots.isAllowed(this.options.target, 'MikuCrawler')) {
            this.socket.emit('stats', {
              ...this.stats,
              log: `⚠️ This site doesn't allow crawling according to robots.txt. Respecting their wishes.`
            })
            logger.warn(`Robots.txt disallows crawling ${this.options.target}`)

            // Store this information
            const db = await dbPromise
            await db.run(
              'INSERT OR REPLACE INTO domain_settings (domain, allowed) VALUES (?, 0)',
              this.targetDomain
            )

            this.stop()
            return
          }

          // Get crawl delay from robots.txt
          const crawlDelay = robots.getCrawlDelay('MikuCrawler')
          if (crawlDelay) {
            const delayMs = Math.max(crawlDelay * 1000, this.options.crawlDelay)
            this.domainDelays.set(this.targetDomain, delayMs)
            logger.info(
              `Using robots.txt crawl delay for ${this.targetDomain}: ${delayMs}ms`
            )
          }
        } catch (err) {
          logger.error(`Error checking robots.txt: ${err.message}`)
        }
      }

      // Start with the target
      this.enqueue({url: this.options.target, depth: 0, retries: 0})
      this.processQueue()
    } catch (err) {
      logger.error(`Error starting crawl: ${err.message}`)
      this.socket.emit('stats', {
        ...this.stats,
        log: `⚠️ Error starting crawler: ${err.message}`
      })
      this.stop()
    }
  }

  enqueue(item) {
    if (!this.visited.has(item.url)) {
      this.queue.push(item)
      // Log enqueued item for deeper depths
      if (item.depth > 0) {
        logger.debug(`Enqueued: ${item.url} at depth ${item.depth}`)
      }
    }
  }

  async processQueue() {
    // Keep track of domains being processed to implement per-domain rate limiting
    const domainProcessing = new Map()

    while ((this.queue.length > 0 || this.activeCount > 0) && this.isActive) {
      // Process as many items as possible up to maxConcurrentRequests
      while (
        this.activeCount < this.options.maxConcurrentRequests &&
        this.queue.length > 0
      ) {
        const item = this.queue.shift()

        try {
          // Get domain of URL
          const url = new URL(item.url)
          const domain = url.hostname

          // Check if we're already processing this domain and need to respect crawl delay
          const lastProcessed = domainProcessing.get(domain) || 0
          const now = Date.now()
          const domainDelay =
            this.domainDelays.get(domain) || this.options.crawlDelay

          if (now - lastProcessed < domainDelay) {
            // Put back in queue and continue with next item
            this.queue.push(item)
            continue
          }

          // Mark this domain as being processed
          domainProcessing.set(domain, now)

          // Process the item
          this.activeCount++
          this.fetchPage(item).finally(() => {
            this.activeCount--
          })
        } catch (err) {
          logger.error(`Error in queue processing: ${err.message}`)
          this.activeCount--
        }
      }

      // Emit live stats periodically
      if (this.activeCount > 0 || this.queue.length > 0) {
        this.socket.volatile.emit('queueStats', {
          activeRequests: this.activeCount,
          queueLength: this.queue.length,
          elapsedTime: Math.floor((Date.now() - this.startTime) / 1000),
          pagesPerSecond:
            this.stats.pagesScanned / ((Date.now() - this.startTime) / 1000)
        })
      }

      // Small pause to prevent CPU hogging
      await new Promise(r => setTimeout(r, 100))
    }

    if (this.isActive) {
      // All done, clean up
      this.stop()
    }
  }

  async fetchPage(item) {
    if (this.stats.pagesScanned >= this.options.maxPages || !this.isActive)
      return
    if (this.visited.has(item.url)) return

    let content = ''
    let $
    let statusCode = 0
    let contentType = ''
    let contentLength = 0
    let title = ''
    let description = ''
    let isDynamic = false
    let lastModified = null

    try {
      logger.info(`Fetching: ${item.url}`)

      // Check if we should use dynamic content fetching (Puppeteer)
      if (this.options.dynamic && this.browser) {
        isDynamic = true
        const page = await this.browser.newPage()

        // Set user agent to identify our crawler
        await page.setUserAgent(
          'MikuCrawler/1.0 (+https://mikucrawler.example.com)'
        )

        // Set viewport to a reasonable size
        await page.setViewport({width: 1280, height: 720})

        // Handle dialogs automatically
        page.on('dialog', async dialog => {
          await dialog.dismiss()
        })

        try {
          // Navigation with timeout
          const response = await page.goto(item.url, {
            waitUntil: 'networkidle2',
            timeout: 20000
          })

          // Extract HTTP status and headers
          statusCode = response.status()
          contentType = response.headers()['content-type'] || ''
          contentLength = parseInt(
            response.headers()['content-length'] || '0',
            10
          )
          lastModified = response.headers()['last-modified']

          // Set cookies to skip pop-ups (optional)
          try {
            await page.setCookie({
              name: 'cookie_consent',
              value: 'true',
              domain: new URL(item.url).hostname
            })
          } catch {}

          // Get page content
          content = await page.content()

          // Get page title and description
          title = await page.title()
          description = await page
            .$eval('meta[name="description"]', el => el.content)
            .catch(() => '')

          // Optionally take a screenshot
          if (this.options.screenshots) {
            await page.screenshot({
              path: `./data/screenshots/${
                new URL(item.url).hostname
              }_${Date.now()}.png`,
              fullPage: false,
              type: 'jpeg',
              quality: 70
            })
          }

          await page.close()
        } catch (err) {
          logger.error(`Puppeteer error for ${item.url}: ${err.message}`)
          await page.close()
          throw err
        }
      } else {
        // Use axios for static content
        const response = await axios.get(item.url, {
          timeout: 10000,
          maxContentLength: 5 * 1024 * 1024, // 5MB limit
          headers: {
            'User-Agent': 'MikuCrawler/1.0 (+https://mikucrawler.example.com)'
          }
        })

        content = response.data
        statusCode = response.status
        contentType = response.headers['content-type'] || ''
        contentLength = parseInt(response.headers['content-length'] || '0', 10)
        lastModified = response.headers['last-modified']

        // For HTML content, extract metadata
        if (contentType.includes('text/html')) {
          $ = cheerio.load(content)
          const metadata = extractMetadata($)
          title = metadata.title
          description = metadata.description
        }
      }

      // Mark as visited
      this.visited.add(item.url)
      this.stats.pagesScanned++
      this.stats.successCount++

      // Calculate content length if not provided in headers
      if (!contentLength && content) {
        contentLength = Buffer.byteLength(content, 'utf8')
      }

      this.stats.totalData += Math.floor(contentLength / 1024) // KB

      // Get domain of URL
      const url = new URL(item.url)
      const domain = url.hostname

      // Insert into database
      const db = await dbPromise
      const sanitizedContent = contentType.includes('text/html')
        ? sanitizeHtml(content, {
            allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
            allowedAttributes: {
              ...sanitizeHtml.defaults.allowedAttributes,
              '*': ['class', 'id', 'style']
            }
          })
        : content

      const result = await db.run(
        `INSERT OR REPLACE INTO pages 
        (url, domain, content_type, status_code, data_length, title, description, content, is_dynamic, last_modified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        item.url,
        domain,
        contentType,
        statusCode,
        contentLength,
        title,
        description,
        this.options.contentOnly ? null : sanitizedContent, // Save content only if needed
        isDynamic ? 1 : 0,
        lastModified
      )

      // Parse content and extract links if HTML
      let links = []
      if (contentType.includes('text/html')) {
        // If $ is not already defined from axios flow, load it now
        if (!$) {
          $ = cheerio.load(content)
        }

        links = this.extractLinks($, item.url)
        this.stats.linksFound += links.length

        // Store links in database
        if (links.length > 0 && result.lastID) {
          const sourceId = result.lastID
          const linkInsertPromises = links.map(link => {
            return db
              .run(
                'INSERT OR IGNORE INTO links (source_id, target_url, text) VALUES (?, ?, ?)',
                sourceId,
                link.url,
                link.text || ''
              )
              .catch(err => {
                logger.warn(`Failed to insert link: ${err.message}`)
              })
          })

          await Promise.allSettled(linkInsertPromises)
        }
      }

      // Handle media files if this crawl method includes them
      if (
        (this.options.crawlMethod === 'media' ||
          this.options.crawlMethod === 'full') &&
        contentType.match(/image|video|audio|application\/(pdf|zip)/i)
      ) {
        this.stats.mediaFiles++
      }

      // Emit stats update to client
      this.socket.emit('stats', {
        ...this.stats,
        log: `🕷️ Crawled: ${item.url} (${statusCode}) [${Math.floor(
          contentLength / 1024
        )}KB] ${links.length ? `Found ${links.length} links` : ''}`
      })

      // Emit page content to client
      // Send sanitized content to avoid XSS when displaying in browser
      const pageForClient = {
        url: item.url,
        content: sanitizedContent,
        title,
        description,
        contentType,
        domain
      }

      this.socket.emit('pageContent', pageForClient)

      // Enqueue more links if we haven't reached depth limit
      if (item.depth < this.options.crawlDepth - 1) {
        // Filter links to process
        const linksToProcess = links.filter(link => !this.visited.has(link.url))

        // Check for robots.txt before enqueuing
        if (this.options.respectRobots) {
          for (const link of linksToProcess) {
            try {
              const linkUrl = new URL(link.url)
              const linkDomain = linkUrl.hostname

              // Only check robots.txt for new domains
              if (linkDomain !== domain && linkDomain !== this.targetDomain) {
                const robots = await getRobotsRules(linkDomain)

                if (!robots.isAllowed(link.url, 'MikuCrawler')) {
                  logger.debug(
                    `Skipping ${link.url} - disallowed by robots.txt`
                  )
                  this.stats.skippedCount++
                  continue
                }

                // Get crawl delay for this domain
                const crawlDelay = robots.getCrawlDelay('MikuCrawler')
                if (crawlDelay) {
                  const delayMs = Math.max(
                    crawlDelay * 1000,
                    this.options.crawlDelay
                  )
                  this.domainDelays.set(linkDomain, delayMs)
                } else {
                  this.domainDelays.set(linkDomain, this.options.crawlDelay)
                }
              }

              this.enqueue({
                url: link.url,
                depth: item.depth + 1,
                retries: 0,
                parentUrl: item.url
              })
            } catch (err) {
              logger.debug(`Error processing link ${link.url}: ${err.message}`)
            }
          }
        } else {
          // Just enqueue all links without checking robots.txt
          linksToProcess.forEach(link => {
            this.enqueue({
              url: link.url,
              depth: item.depth + 1,
              retries: 0,
              parentUrl: item.url
            })
          })
        }
      }

      // Crawl delay - use the domain-specific delay
      const domainDelay =
        this.domainDelays.get(domain) || this.options.crawlDelay
      await new Promise(r => setTimeout(r, domainDelay))
    } catch (err) {
      this.stats.failureCount++
      logger.error(`Error crawling ${item.url}: ${err.message}`)

      this.socket.emit('stats', {
        ...this.stats,
        log: `⚠️ Error crawling ${item.url}: ${err.message}`
      })

      // Retry logic with exponential backoff
      if (item.retries < this.options.retryLimit) {
        item.retries++
        const backoffDelay = Math.min(1000 * Math.pow(2, item.retries), 30000) // Max 30s
        logger.info(
          `Retrying ${item.url} in ${backoffDelay}ms (attempt ${item.retries}/${this.options.retryLimit})`
        )

        setTimeout(() => {
          this.enqueue(item)
        }, backoffDelay)
      } else {
        this.visited.add(item.url) // Mark as visited to avoid further attempts
      }
    }
  }

  extractLinks($, baseUrl) {
    const links = new Set()
    const baseHost = new URL(baseUrl).hostname
    const seen = new Set()
    const result = []

    // Extract all links from anchor tags
    $('a').each((_, el) => {
      let href = $(el).attr('href')
      if (!href) return

      try {
        const url = new URL(href, baseUrl)

        // Normalize URL by removing fragments and trailing slashes
        let normalizedUrl = url.href.split('#')[0]
        if (normalizedUrl.endsWith('/')) {
          normalizedUrl = normalizedUrl.slice(0, -1)
        }

        // Skip already seen URLs
        if (seen.has(normalizedUrl)) return
        seen.add(normalizedUrl)

        // Skip non-HTTP protocols
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return

        // If crawling the same domain only
        if (this.options.crawlMethod !== 'full' && url.hostname !== baseHost)
          return

        // Skip common non-content URLs
        if (
          url.pathname.match(
            /\.(css|js|json|xml|txt|md|csv|svg|ico|git|gitignore)$/i
          )
        )
          return

        // Add link with text
        result.push({
          url: url.href,
          text: $(el).text().trim()
        })
      } catch (e) {
        // Ignore invalid URLs
      }
    })

    // Extract media links if configured to do so
    if (
      this.options.crawlMethod === 'media' ||
      this.options.crawlMethod === 'full'
    ) {
      $('img, video, audio, source').each((_, el) => {
        let src = $(el).attr('src')
        if (!src) return

        try {
          const url = new URL(src, baseUrl)
          const normalizedUrl = url.href.split('#')[0]

          if (seen.has(normalizedUrl)) return
          seen.add(normalizedUrl)

          if (url.protocol !== 'http:' && url.protocol !== 'https:') return

          // For media, we can allow external domains
          result.push({
            url: url.href,
            text: $(el).attr('alt') || ''
          })
        } catch (e) {
          // Ignore invalid URLs
        }
      })
    }

    return result.slice(0, 200) // Limit to 200 links per page
  }

  async stop() {
    if (!this.isActive) return

    this.isActive = false

    // Calculate elapsed time
    const elapsedSeconds = Math.floor((Date.now() - this.startTime) / 1000)
    const elapsedTime = {
      hours: Math.floor(elapsedSeconds / 3600),
      minutes: Math.floor((elapsedSeconds % 3600) / 60),
      seconds: elapsedSeconds % 60
    }

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
        : '0%'
    }

    if (this.browser) {
      try {
        await this.browser.close()
        logger.info('Puppeteer closed.')
      } catch (err) {
        logger.error(`Error closing browser: ${err.message}`)
      }
    }

    logger.info(`Crawl session ended. Stats: ${JSON.stringify(finalStats)}`)
    this.socket.emit('attackEnd', finalStats)
  }
}

// Socket.IO Connection
const activeCrawls = new Map()

io.on('connection', socket => {
  logger.info(`Client connected: ${socket.id}`)
  let crawlSession = null

  socket.on('startAttack', options => {
    if (crawlSession) {
      crawlSession.stop()
    }

    logger.info(
      `Starting new crawl session for ${socket.id} with target: ${options.target}`
    )

    // Validate all options coming from client
    const validated = {
      target: options.target,
      crawlDepth: options.crawlDepth,
      maxPages: options.maxPages,
      crawlDelay: options.crawlDelay,
      crawlMethod: options.crawlMethod,
      maxConcurrentRequests: options.maxConcurrentRequests,
      retryLimit: options.retryLimit,
      dynamic: options.dynamic !== false,
      respectRobots: options.respectRobots !== false,
      contentOnly: options.contentOnly || false
    }

    crawlSession = new AdvancedCrawlSession(socket, validated)
    activeCrawls.set(socket.id, crawlSession)
    crawlSession.start()
  })

  socket.on('stopAttack', () => {
    logger.info(`Stopping crawl session for ${socket.id}`)
    if (crawlSession) {
      crawlSession.stop()
      activeCrawls.delete(socket.id)
      crawlSession = null
    }
  })

  socket.on('getPageDetails', async url => {
    try {
      if (!url) return

      const db = await dbPromise
      const page = await db.get(`SELECT * FROM pages WHERE url = ?`, url)

      if (page) {
        const links = await db.all(
          `SELECT * FROM links WHERE source_id = ?`,
          page.id
        )

        socket.emit('pageDetails', {...page, links})
      } else {
        socket.emit('pageDetails', null)
      }
    } catch (err) {
      logger.error(`Error getting page details: ${err.message}`)
      socket.emit('error', {message: 'Failed to get page details'})
    }
  })

  socket.on('exportData', async format => {
    try {
      const db = await dbPromise
      const pages =
        await db.all(`SELECT id, url, domain, crawled_at, status_code, 
                                 data_length, title, description FROM pages`)

      let result
      if (format === 'json') {
        result = JSON.stringify(pages, null, 2)
      } else if (format === 'csv') {
        // Simple CSV conversion
        const headers = Object.keys(pages[0] || {}).join(',')
        const rows = pages.map(page => Object.values(page).join(',')).join('\n')
        result = headers + '\n' + rows
      } else {
        throw new Error('Unsupported export format')
      }

      socket.emit('exportResult', {data: result, format})
    } catch (err) {
      logger.error(`Error exporting data: ${err.message}`)
      socket.emit('error', {message: 'Failed to export data'})
    }
  })

  socket.on('disconnect', () => {
    if (crawlSession) {
      crawlSession.stop()
      activeCrawls.delete(socket.id)
    }
    logger.info(`Client disconnected: ${socket.id}`)
  })
})

// API endpoints
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeCrawls: activeCrawls.size,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  })
})

app.get('/api/stats', async (req, res) => {
  try {
    const db = await dbPromise
    const stats = await db.get(`
      SELECT 
        COUNT(*) as totalPages,
        SUM(data_length) as totalDataSize,
        COUNT(DISTINCT domain) as uniqueDomains,
        MAX(crawled_at) as lastCrawled
      FROM pages
    `)

    res.json({
      status: 'ok',
      stats: {
        ...stats,
        activeCrawls: activeCrawls.size
      }
    })
  } catch (err) {
    logger.error(`Error getting stats: ${err.message}`)
    res.status(500).json({error: 'Failed to get statistics'})
  }
})

// Start the server
const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  logger.info(`Advanced Miku Crawler Beam backend running on port ${PORT}`)
})

// Handle shutdown gracefully
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully')

  // Close all active crawl sessions
  for (const [_, session] of activeCrawls) {
    await session.stop()
  }

  // Close server
  server.close(() => {
    logger.info('Server closed')
    process.exit(0)
  })
})

export default app