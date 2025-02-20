import dotenv from "dotenv";
dotenv.config();
import express from "express";
import http from "http";
import { Server } from "socket.io";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import { URL } from "url";
import rateLimit from "express-rate-limit";
import puppeteer from "puppeteer";
import winston from "winston";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// SETUP: Logging (Winston)
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/crawler.log" }),
  ],
});

// SETUP: Persistent Storage (SQLite)
const dbPromise = open({
  filename: "./crawler.db",
  driver: sqlite3.Database,
}).then(async (db) => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE,
      crawled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      data_length INTEGER,
      content TEXT
    );
  `);
  return db;
});

// SETUP: Express, HTTP & Socket.IO
const app = express();
const server = http.createServer(app);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL, // from .env (or default)
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// Rate limit for safety
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
});
app.use(limiter);

// Advanced Crawl Session Class
class AdvancedCrawlSession {
  constructor(socket, options) {
    this.socket = socket;
    this.options = {
      target: options.target,
      crawlDepth: Math.min(options.crawlDepth || 2, 5),
      maxPages: Math.min(options.maxPages || 50, 100),
      crawlDelay: Math.max(options.crawlDelay || 1000, 500),
      crawlMethod: options.crawlMethod || "links",
      maxConcurrentRequests: options.maxConcurrentRequests || 5,
      retryLimit: options.retryLimit || 3,
      dynamic: true, // Always use Puppeteer-based dynamic content
    };

    this.visited = new Set();
    this.queue = [];
    this.stats = {
      pagesScanned: 0,
      linksFound: 0,
      totalData: 0, // in KB
    };
    this.isActive = true;
    this.activeCount = 0;
    this.browser = null;
  }

  async start() {
    try {
      this.browser = await puppeteer.launch({ headless: true });
      logger.info("Puppeteer launched for dynamic content handling.");
    } catch (err) {
      logger.error("Error launching Puppeteer: " + err.message);
      this.options.dynamic = false; // fallback to axios
    }
    // Start with the target
    this.enqueue({ url: this.options.target, depth: 0, retries: 0 });
    this.processQueue();
  }

  enqueue(item) {
    if (!this.visited.has(item.url)) {
      this.queue.push(item);
    }
  }

  async processQueue() {
    while ((this.queue.length > 0 || this.activeCount > 0) && this.isActive) {
      while (
        this.activeCount < this.options.maxConcurrentRequests &&
        this.queue.length > 0
      ) {
        const item = this.queue.shift();
        this.activeCount++;
        this.fetchPage(item).finally(() => {
          this.activeCount--;
        });
      }
      // small pause
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.isActive) {
      this.stop();
    }
  }

  async fetchPage(item) {
    if (this.stats.pagesScanned >= this.options.maxPages || !this.isActive)
      return;
    if (this.visited.has(item.url)) return;

    let content = "";
    try {
      if (this.options.dynamic && this.browser) {
        const page = await this.browser.newPage();
        await page.goto(item.url, {
          waitUntil: "networkidle2",
          timeout: 15000,
        });
        // Optional: set cookie to skip pop-ups
        try {
          await page.setCookie({
            name: "cookie_consent",
            value: "true",
            domain: new URL(item.url).hostname,
          });
        } catch {}
        content = await page.content();
        await page.close();
      } else {
        const response = await axios.get(item.url, {
          timeout: 5000,
          maxContentLength: 1024 * 1024,
        });
        content = response.data;
      }

      this.visited.add(item.url);
      this.stats.pagesScanned++;
      this.stats.totalData += Math.floor(content.length / 1024); // KB

      const db = await dbPromise;
      await db.run(
        "INSERT OR IGNORE INTO pages (url, data_length, content) VALUES (?, ?, ?)",
        item.url,
        content.length,
        content
      );

      // parse with cheerio
      const $ = cheerio.load(content);
      const links = this.extractLinks($, item.url);
      this.stats.linksFound += links.length;

      // enqueue more
      if (item.depth < this.options.crawlDepth - 1) {
        links.forEach((link) => {
          if (!this.visited.has(link)) {
            this.enqueue({ url: link, depth: item.depth + 1, retries: 0 });
          }
        });
      }

      // Emit stats
      this.socket.emit("stats", {
        ...this.stats,
        log: `🕷️ Crawled: ${item.url} (Found ${links.length} links)`,
      });
      logger.info(`Crawled: ${item.url} (Found ${links.length} links)`);

      // Emit full content
      this.socket.emit("pageContent", { url: item.url, content });

      await new Promise((r) => setTimeout(r, this.options.crawlDelay));
    } catch (err) {
      logger.error(`Error crawling ${item.url}: ${err.message}`);
      this.socket.emit("stats", {
        ...this.stats,
        log: `⚠️ Error crawling ${item.url}: ${err.message}`,
      });
      if (item.retries < this.options.retryLimit) {
        item.retries++;
        this.enqueue(item);
      } else {
        this.visited.add(item.url);
      }
    }
  }

  extractLinks($, baseUrl) {
    const links = new Set();
    const baseHost = new URL(baseUrl).hostname;
    $("a").each((_, el) => {
      let href = $(el).attr("href");
      if (!href) return;
      try {
        const url = new URL(href, baseUrl);
        if (url.hostname === baseHost) {
          links.add(url.href);
        }
      } catch {}
    });
    return [...links].slice(0, 100);
  }

  async stop() {
    this.isActive = false;
    if (this.browser) {
      try {
        await this.browser.close();
        logger.info("Puppeteer closed.");
      } catch {}
    }
    this.socket.emit("attackEnd", this.stats);
  }
}

// Socket.IO Connection
const activeCrawls = new Map();

io.on("connection", (socket) => {
  logger.info("Client connected");
  let crawlSession = null;

  socket.on("startAttack", (options) => {
    if (crawlSession) {
      crawlSession.stop();
    }
    const validated = {
      target: options.target,
      crawlDepth: options.crawlDepth,
      maxPages: options.maxPages,
      crawlDelay: options.crawlDelay,
      crawlMethod: options.crawlMethod,
      maxConcurrentRequests: options.maxConcurrentRequests,
      retryLimit: options.retryLimit,
      dynamic: true,
    };

    crawlSession = new AdvancedCrawlSession(socket, validated);
    activeCrawls.set(socket.id, crawlSession);
    crawlSession.start();
  });

  socket.on("stopAttack", () => {
    if (crawlSession) {
      crawlSession.stop();
      activeCrawls.delete(socket.id);
      crawlSession = null;
    }
  });

  socket.on("disconnect", () => {
    if (crawlSession) {
      crawlSession.stop();
      activeCrawls.delete(socket.id);
    }
    logger.info("Client disconnected");
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", activeCrawls: activeCrawls.size });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Advanced Miku Crawler Beam backend running on port ${PORT}`);
});
