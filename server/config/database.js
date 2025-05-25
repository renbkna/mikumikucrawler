import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { mkdir, existsSync } from 'fs';
import { promisify } from 'util';

const mkdirAsync = promisify(mkdir);

const ensureDirectoryExists = async (dir) => {
  if (!existsSync(dir)) {
    await mkdirAsync(dir, { recursive: true });
  }
};

export const setupDatabase = async () => {
  await ensureDirectoryExists('./data');

  const db = await open({
    filename: './data/crawler.db',
    driver: sqlite3.Database,
  });

  // Enable WAL mode for better concurrency
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA synchronous = NORMAL;');

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
  `);

  return db;
};
