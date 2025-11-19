import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import { promisify } from 'util';

const mkdirAsync = promisify(fs.mkdir);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

const DB_PATH = './data/crawler.db';

// Ensure directories exist
const ensureDirectoryExists = async (dir) => {
  if (!fs.existsSync(dir)) {
    await mkdirAsync(dir, { recursive: true });
  }
};

let dbInstance = null;
let SQL = null;

// Helper to save DB to disk
export const saveDatabase = async () => {
  if (dbInstance) {
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    await ensureDirectoryExists(path.dirname(DB_PATH));
    await writeFileAsync(DB_PATH, buffer);
  }
};

// SETUP: Persistent Storage (sql.js)
export const setupDatabase = async () => {
  await ensureDirectoryExists('./data');

  if (!SQL) {
    SQL = await initSqlJs();
  }

  if (fs.existsSync(DB_PATH)) {
    const filebuffer = await readFileAsync(DB_PATH);
    dbInstance = new SQL.Database(filebuffer);
  } else {
    dbInstance = new SQL.Database();
  }

  // Wrap dbInstance to mimic better-sqlite3 API partially for compatibility
  const dbWrapper = {
    prepare: (sql) => {
      const stmt = dbInstance.prepare(sql);
      return {
        run: (...args) => {
          stmt.run(args);
          stmt.free();
          saveDatabase(); // Auto-save on write
          return { changes: dbInstance.getRowsModified() };
        },
        get: (...args) => {
          const res = stmt.getAsObject(args);
          stmt.free();
          // Check if result is empty object (sql.js returns {} if no result)
          return Object.keys(res).length > 0 ? res : undefined;
        },
        all: (...args) => {
          stmt.bind(args);
          const result = [];
          while (stmt.step()) {
            result.push(stmt.getAsObject());
          }
          stmt.free();
          return result;
        }
      };
    },
    exec: (sql) => {
      dbInstance.run(sql);
      saveDatabase();
    },
    transaction: (fn) => {
      return (...args) => {
        dbInstance.run("BEGIN TRANSACTION");
        try {
          fn(...args);
          dbInstance.run("COMMIT");
          saveDatabase();
        } catch (err) {
          dbInstance.run("ROLLBACK");
          throw err;
        }
      };
    },
    close: () => {
      saveDatabase();
      dbInstance.close();
    }
  };

  // Create tables
  dbWrapper.exec(`
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

  // Migration logic (simplified for sql.js)
  try {
    // Check for columns by trying to select them. If fail, add them.
    // sql.js doesn't support PRAGMA table_info easily in the same way or it returns different format.
    // We'll try a safe add column approach or just skip if it exists.
    // Actually, sql.js throws if column exists on ADD COLUMN? No, SQLite supports IF NOT EXISTS for tables but not columns.
    // We will try to select one new column, if it fails, we assume we need to migrate.
    try {
      dbWrapper.prepare("SELECT main_content FROM pages LIMIT 1").get();
    } catch (e) {
      // Column doesn't exist, add them
      const newColumns = [
        'main_content TEXT',
        'word_count INTEGER',
        'reading_time INTEGER',
        'language TEXT',
        'keywords TEXT',
        'quality_score INTEGER',
        'structured_data TEXT',
        'media_count INTEGER',
        'internal_links_count INTEGER',
        'external_links_count INTEGER',
      ];
      for (const col of newColumns) {
        try {
          dbWrapper.exec(`ALTER TABLE pages ADD COLUMN ${col}`);
        } catch (err) {
          // Ignore if already exists
        }
      }
    }
  } catch (e) {
    console.error("Migration check failed", e);
  }

  return dbWrapper;
};
