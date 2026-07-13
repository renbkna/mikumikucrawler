PRAGMA defer_foreign_keys = ON;

DROP TRIGGER IF EXISTS pages_ai;
DROP TRIGGER IF EXISTS pages_ad;
DROP TRIGGER IF EXISTS pages_au;
DROP TABLE IF EXISTS pages_fts;

CREATE TABLE canonical_crawl_runs (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'pending',
    'starting',
    'running',
    'pausing',
    'paused',
    'stopping',
    'completed',
    'stopped',
    'failed',
    'interrupted'
  )),
  stop_reason TEXT,
  options_json TEXT NOT NULL CHECK(json_valid(options_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  pages_scanned INTEGER NOT NULL DEFAULT 0 CHECK(typeof(pages_scanned) = 'integer' AND pages_scanned >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(success_count) = 'integer' AND success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(failure_count) = 'integer' AND failure_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(skipped_count) = 'integer' AND skipped_count >= 0),
  links_found INTEGER NOT NULL DEFAULT 0 CHECK(typeof(links_found) = 'integer' AND links_found >= 0),
  media_files INTEGER NOT NULL DEFAULT 0 CHECK(typeof(media_files) = 'integer' AND media_files >= 0),
  total_data_kb INTEGER NOT NULL DEFAULT 0 CHECK(typeof(total_data_kb) = 'integer' AND total_data_kb >= 0),
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(event_sequence) = 'integer'
    AND event_sequence BETWEEN 0 AND 9007199254740991
  ),
  CHECK(target = json_extract(options_json, '$.target')),
  CHECK(pages_scanned = success_count + failure_count + skipped_count)
);

INSERT INTO canonical_crawl_runs
SELECT * FROM crawl_runs;

CREATE TABLE canonical_crawl_queue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK(typeof(depth) = 'integer' AND depth >= 0),
  retries INTEGER NOT NULL DEFAULT 0 CHECK(typeof(retries) = 'integer' AND retries >= 0),
  parent_url TEXT,
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  available_at INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(available_at) = 'integer'
    AND available_at BETWEEN 0 AND 9007199254740991
  ),
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE,
  UNIQUE(crawl_id, url)
);

INSERT INTO canonical_crawl_queue_items
SELECT id, crawl_id, url, depth, retries, parent_url, domain, created_at, available_at
FROM crawl_queue_items;

CREATE TABLE canonical_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  crawled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_modified TEXT,
  etag TEXT,
  content_type TEXT,
  status_code INTEGER,
  data_length INTEGER,
  title TEXT,
  description TEXT,
  content TEXT,
  is_dynamic INTEGER NOT NULL DEFAULT 0 CHECK(is_dynamic IN (0, 1)),
  main_content TEXT,
  word_count INTEGER CHECK(word_count IS NULL OR word_count >= 0),
  reading_time INTEGER CHECK(reading_time IS NULL OR reading_time >= 0),
  language TEXT,
  keywords TEXT,
  quality_score INTEGER CHECK(quality_score IS NULL OR quality_score >= 0),
  structured_data TEXT,
  media_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(media_count) = 'integer' AND media_count >= 0),
  internal_links_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(internal_links_count) = 'integer' AND internal_links_count >= 0),
  external_links_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(external_links_count) = 'integer' AND external_links_count >= 0),
  discovered_links_count INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(discovered_links_count) = 'integer'
    AND discovered_links_count >= 0
  ),
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE,
  UNIQUE(crawl_id, url)
);

INSERT INTO canonical_pages
SELECT
  id,
  crawl_id,
  url,
  domain,
  crawled_at,
  last_modified,
  etag,
  content_type,
  status_code,
  data_length,
  title,
  description,
  content,
  is_dynamic,
  main_content,
  word_count,
  reading_time,
  language,
  keywords,
  quality_score,
  structured_data,
  media_count,
  internal_links_count,
  external_links_count,
  discovered_links_count
FROM pages;

CREATE TABLE canonical_page_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  target_url TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  nofollow INTEGER NOT NULL DEFAULT 0 CHECK(nofollow IN (0, 1)),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  UNIQUE(page_id, target_url)
);

INSERT INTO canonical_page_links
SELECT id, page_id, target_url, text, nofollow
FROM page_links;

CREATE TABLE canonical_crawl_terminal_urls (
  terminal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'skip')),
  domain_budget_charged INTEGER NOT NULL DEFAULT 0 CHECK(domain_budget_charged IN (0, 1)),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (crawl_id, url),
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
);

INSERT INTO canonical_crawl_terminal_urls
  (terminal_sequence, crawl_id, url, outcome, domain_budget_charged, recorded_at)
SELECT
  terminal_sequence,
  crawl_id,
  url,
  outcome,
  domain_budget_charged,
  recorded_at
FROM crawl_terminal_urls;

CREATE TABLE canonical_crawl_domain_state (
  crawl_id TEXT NOT NULL,
  delay_key TEXT NOT NULL,
  delay_ms INTEGER NOT NULL CHECK(
    typeof(delay_ms) = 'integer'
    AND delay_ms BETWEEN 0 AND 60000
  ),
  next_allowed_at INTEGER NOT NULL CHECK(
    typeof(next_allowed_at) = 'integer'
    AND next_allowed_at BETWEEN 0 AND 9007199254740991
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crawl_id, delay_key),
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
);

INSERT INTO canonical_crawl_domain_state
SELECT crawl_id, delay_key, delay_ms, next_allowed_at, updated_at
FROM crawl_domain_state;

DROP TABLE page_links;
DROP TABLE crawl_terminal_urls;
DROP TABLE crawl_queue_items;
DROP TABLE crawl_domain_state;
DROP TABLE pages;
DROP TABLE crawl_runs;

ALTER TABLE canonical_crawl_runs RENAME TO crawl_runs;
ALTER TABLE canonical_crawl_queue_items RENAME TO crawl_queue_items;
ALTER TABLE canonical_pages RENAME TO pages;
ALTER TABLE canonical_page_links RENAME TO page_links;
ALTER TABLE canonical_crawl_terminal_urls RENAME TO crawl_terminal_urls;
ALTER TABLE canonical_crawl_domain_state RENAME TO crawl_domain_state;

CREATE INDEX idx_crawl_runs_status_updated_at
ON crawl_runs(status, updated_at DESC);

CREATE INDEX idx_crawl_queue_items_crawl_id
ON crawl_queue_items(crawl_id, created_at ASC);

CREATE INDEX idx_pages_crawl_id
ON pages(crawl_id, crawled_at DESC);

CREATE INDEX idx_pages_domain
ON pages(domain);

CREATE INDEX idx_page_links_page_id
ON page_links(page_id);

CREATE INDEX idx_crawl_terminal_urls_crawl_id
ON crawl_terminal_urls(crawl_id, terminal_sequence ASC);

CREATE INDEX idx_crawl_domain_state_crawl_id
ON crawl_domain_state(crawl_id, delay_key);

CREATE VIRTUAL TABLE pages_fts USING fts5(
  url,
  title,
  description,
  content,
  content='pages',
  content_rowid='id',
  tokenize='porter unicode61'
);

INSERT INTO pages_fts(rowid, url, title, description, content)
SELECT
  id,
  url,
  COALESCE(title, ''),
  COALESCE(description, ''),
  COALESCE(NULLIF(main_content, ''), NULLIF(content, ''), '')
FROM pages;

CREATE TRIGGER pages_ai
AFTER INSERT ON pages
BEGIN
  INSERT INTO pages_fts(rowid, url, title, description, content)
  VALUES (
    NEW.id,
    NEW.url,
    COALESCE(NEW.title, ''),
    COALESCE(NEW.description, ''),
    COALESCE(NULLIF(NEW.main_content, ''), NULLIF(NEW.content, ''), '')
  );
END;

CREATE TRIGGER pages_ad
AFTER DELETE ON pages
BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, url, title, description, content)
  VALUES (
    'delete',
    OLD.id,
    OLD.url,
    COALESCE(OLD.title, ''),
    COALESCE(OLD.description, ''),
    COALESCE(NULLIF(OLD.main_content, ''), NULLIF(OLD.content, ''), '')
  );
END;

CREATE TRIGGER pages_au
AFTER UPDATE ON pages
BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, url, title, description, content)
  VALUES (
    'delete',
    OLD.id,
    OLD.url,
    COALESCE(OLD.title, ''),
    COALESCE(OLD.description, ''),
    COALESCE(NULLIF(OLD.main_content, ''), NULLIF(OLD.content, ''), '')
  );

  INSERT INTO pages_fts(rowid, url, title, description, content)
  VALUES (
    NEW.id,
    NEW.url,
    COALESCE(NEW.title, ''),
    COALESCE(NEW.description, ''),
    COALESCE(NULLIF(NEW.main_content, ''), NULLIF(NEW.content, ''), '')
  );
END;
