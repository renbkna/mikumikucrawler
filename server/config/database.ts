import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/crawler.db";

const ensureDirectoryExists = (filePath: string) => {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
};

let dbInstance: Database | null = null;

export const setupDatabase = (): Database => {
	ensureDirectoryExists(DB_PATH);

	if (!dbInstance) {
		dbInstance = new Database(DB_PATH);
		dbInstance.exec("PRAGMA journal_mode = WAL;");
	}

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
  `);

	/** Checks for schema updates and applies migrations. */
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
					const message = err instanceof Error ? err.message : String(err);
					if (!message.includes("duplicate column")) {
						console.error(`Migration failed for column ${col}:`, message);
					}
				}
			}
		}
	} catch (e) {
		console.error("Migration check failed", e);
	}

	return dbInstance;
};
