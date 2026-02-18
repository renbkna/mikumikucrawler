import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../utils/helpers.js";
import { config } from "./env.js";
import type { Logger } from "./logging.js";

const DB_PATH = config.dbPath;

const ensureDirectoryExists = (filePath: string): void => {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
};

// Eager initialization at module load time eliminates race conditions
// Top-level execution ensures this runs exactly once
ensureDirectoryExists(DB_PATH);

const dbInstance = new Database(DB_PATH);

// Performance optimizations for read-heavy crawler workload
dbInstance.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA synchronous = NORMAL;
	PRAGMA cache_size = -16000;		-- 16MB cache (reduced from 64MB)
	PRAGMA temp_store = MEMORY;
	PRAGMA mmap_size = 67108864;		-- 64MB mmap (reduced from 256MB)
	PRAGMA busy_timeout = 5000;
	PRAGMA foreign_keys = ON;
`);

// Initialize schema at module load time
dbInstance.exec(`
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
		is_dynamic BOOLEAN DEFAULT 0,
		main_content TEXT,
		word_count INTEGER,
		reading_time INTEGER,
		language TEXT,
		keywords TEXT,
		quality_score INTEGER,
		structured_data TEXT,
		media_count INTEGER,
		internal_links_count INTEGER,
		external_links_count INTEGER
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

	-- Performance optimization: Essential indexes for common lookups
	CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url);
	CREATE INDEX IF NOT EXISTS idx_pages_language ON pages(language);
	CREATE INDEX IF NOT EXISTS idx_pages_quality_score ON pages(quality_score)
		WHERE quality_score IS NOT NULL;
	CREATE INDEX IF NOT EXISTS idx_pages_word_count ON pages(word_count)
		WHERE word_count IS NOT NULL;

	-- Composite indexes for common query patterns
	CREATE INDEX IF NOT EXISTS idx_pages_domain_crawled ON pages(domain, crawled_at);
	CREATE INDEX IF NOT EXISTS idx_pages_crawled_id ON pages(crawled_at, id);

	-- Crawl session persistence for pause/resume support
	CREATE TABLE IF NOT EXISTS crawl_sessions (
		id TEXT PRIMARY KEY,
		socket_id TEXT NOT NULL,
		target TEXT NOT NULL,
		options TEXT NOT NULL,
		stats TEXT,
		status TEXT DEFAULT 'running',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS queue_items (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		url TEXT NOT NULL,
		depth INTEGER NOT NULL,
		retries INTEGER DEFAULT 0,
		parent_url TEXT,
		domain TEXT NOT NULL,
		UNIQUE(session_id, url),
		FOREIGN KEY (session_id) REFERENCES crawl_sessions(id) ON DELETE CASCADE
	);

	CREATE INDEX IF NOT EXISTS idx_sessions_status ON crawl_sessions(status);
	CREATE INDEX IF NOT EXISTS idx_queue_items_session ON queue_items(session_id);

	-- Full-text search over crawled page content using SQLite FTS5.
	-- 'porter ascii' applies Porter stemming so "crawling" matches "crawl".
	-- url is UNINDEXED: stored for retrieval but excluded from ranking.
	CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
		url        UNINDEXED,
		title,
		description,
		main_content,
		keywords,
		content    = 'pages',
		content_rowid = 'id',
		tokenize   = 'porter ascii'
	);

	CREATE TRIGGER IF NOT EXISTS pages_fts_ai
		AFTER INSERT ON pages BEGIN
			INSERT INTO pages_fts(rowid, url, title, description, main_content, keywords)
			VALUES (new.id, new.url, new.title, new.description, new.main_content, new.keywords);
		END;

	CREATE TRIGGER IF NOT EXISTS pages_fts_ad
		AFTER DELETE ON pages BEGIN
			INSERT INTO pages_fts(pages_fts, rowid, url, title, description, main_content, keywords)
			VALUES ('delete', old.id, old.url, old.title, old.description, old.main_content, old.keywords);
		END;

	CREATE TRIGGER IF NOT EXISTS pages_fts_au
		AFTER UPDATE ON pages BEGIN
			INSERT INTO pages_fts(pages_fts, rowid, url, title, description, main_content, keywords)
			VALUES ('delete', old.id, old.url, old.title, old.description, old.main_content, old.keywords);
			INSERT INTO pages_fts(rowid, url, title, description, main_content, keywords)
			VALUES (new.id, new.url, new.title, new.description, new.main_content, new.keywords);
		END;
`);

/**
 * Sets up the database with proper schema and migrations.
 * Returns the eagerly-initialized singleton instance.
 *
 * @param logger - Optional logger for database operations. If not provided,
 *                 errors during bootstrap will be thrown rather than logged.
 */
export const setupDatabase = (logger?: Logger): Database => {
	// Run migrations - these are idempotent and safe to run on every startup
	try {
		const tableInfo = dbInstance.query("PRAGMA table_info(pages)").all() as {
			name: string;
		}[];

		const hasMainContent = tableInfo.some((col) => col.name === "main_content");

		if (!hasMainContent) {
			const newColumns = [
				"main_content TEXT",
				"word_count INTEGER",
				"reading_time INTEGER",
				"language TEXT",
				"keywords TEXT",
				"quality_score INTEGER",
				"structured_data TEXT",
				"media_count INTEGER",
				"internal_links_count INTEGER",
				"external_links_count INTEGER",
			];
			for (const col of newColumns) {
				try {
					dbInstance.exec(`ALTER TABLE pages ADD COLUMN ${col}`);
				} catch (err) {
					// SQLite returns "duplicate column name" if column already exists
					const message = getErrorMessage(err);
					if (!message.includes("duplicate column")) {
						const errorMessage = `Migration failed for column ${col}: ${message}`;
						if (logger) {
							logger.error(errorMessage);
						} else {
							throw new Error(errorMessage);
						}
					}
				}
			}
		}

		// Conditional GET support: add etag column if missing (idempotent)
		const hasEtag = tableInfo.some((col) => col.name === "etag");
		if (!hasEtag) {
			try {
				dbInstance.exec("ALTER TABLE pages ADD COLUMN etag TEXT");
			} catch (err) {
				const message = getErrorMessage(err);
				if (!message.includes("duplicate column")) {
					const errorMessage = `Migration failed for column etag: ${message}`;
					if (logger) {
						logger.error(errorMessage);
					} else {
						throw new Error(errorMessage);
					}
				}
			}
		}

		// FTS5 backfill: if the pages table already has rows but the FTS table is
		// empty (e.g. on first startup after adding the FTS schema), populate it.
		// INSERT INTO pages_fts(pages_fts) VALUES('rebuild') is the idiomatic way
		// to rebuild a content-table FTS index from the underlying source table.
		try {
			const ftsCount = (
				dbInstance
					.query("SELECT COUNT(*) AS n FROM pages_fts")
					.get() as { n: number }
			).n;
			const pagesCount = (
				dbInstance
					.query("SELECT COUNT(*) AS n FROM pages")
					.get() as { n: number }
			).n;

			if (pagesCount > 0 && ftsCount === 0) {
				dbInstance.exec(
					"INSERT INTO pages_fts(pages_fts) VALUES('rebuild')",
				);
				if (logger) {
					logger.info(
						`FTS5 index rebuilt from ${pagesCount} existing pages`,
					);
				}
			}
		} catch (err) {
			// Non-fatal — FTS is a convenience feature, don't abort on rebuild failure
			const message = getErrorMessage(err);
			if (logger) {
				logger.error(`FTS5 rebuild failed: ${message}`);
			}
		}
	} catch (e) {
		const errorMessage = `Migration check failed: ${getErrorMessage(e)}`;
		if (logger) {
			logger.error(errorMessage);
		} else {
			throw new Error(errorMessage);
		}
	}

	return dbInstance;
};
