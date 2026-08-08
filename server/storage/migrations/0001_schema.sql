CREATE TABLE crawl_runs (
  id TEXT PRIMARY KEY,
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
  total_data_bytes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(total_data_bytes) = 'integer' AND total_data_bytes >= 0),
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(event_sequence) = 'integer'
    AND event_sequence BETWEEN 0 AND 9007199254740991
  ),
  CHECK(pages_scanned = success_count + failure_count + skipped_count)
);

CREATE TABLE crawl_queue_items (
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

CREATE TABLE pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  crawled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  content_type TEXT,
  title TEXT,
  description TEXT,
  content TEXT,
  main_content TEXT,
  word_count INTEGER CHECK(word_count IS NULL OR word_count >= 0),
  reading_time INTEGER CHECK(reading_time IS NULL OR reading_time >= 0),
  language TEXT,
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE,
  UNIQUE(crawl_id, url)
);

CREATE TABLE crawl_terminal_urls (
  terminal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'skip')),
  domain_budget_charged INTEGER NOT NULL DEFAULT 0 CHECK(domain_budget_charged IN (0, 1)),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  charged_domain TEXT CHECK(charged_domain IS NULL OR length(charged_domain) > 0),
  UNIQUE(crawl_id, url),
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
);

CREATE TABLE crawl_domain_state (
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

CREATE INDEX idx_crawl_runs_status_updated_at
ON crawl_runs(status, updated_at DESC);

CREATE INDEX idx_crawl_runs_updated_at
ON crawl_runs(updated_at DESC);

CREATE INDEX idx_crawl_queue_items_crawl_id
ON crawl_queue_items(crawl_id, created_at ASC);

CREATE INDEX idx_pages_crawl_id
ON pages(crawl_id, crawled_at DESC);

CREATE INDEX idx_crawl_terminal_urls_crawl_id
ON crawl_terminal_urls(crawl_id, terminal_sequence ASC);

CREATE INDEX idx_crawl_domain_state_crawl_id
ON crawl_domain_state(crawl_id, delay_key);

CREATE TRIGGER prevent_queue_for_terminal_url
BEFORE INSERT ON crawl_queue_items
WHEN EXISTS (
  SELECT 1
  FROM crawl_terminal_urls
  WHERE crawl_terminal_urls.crawl_id = NEW.crawl_id
    AND crawl_terminal_urls.url = NEW.url
)
BEGIN
  SELECT RAISE(ABORT, 'cannot queue a terminal crawl URL');
END;

CREATE TRIGGER prevent_terminal_url_with_queue_item
BEFORE INSERT ON crawl_terminal_urls
WHEN EXISTS (
  SELECT 1
  FROM crawl_queue_items
  WHERE crawl_queue_items.crawl_id = NEW.crawl_id
    AND crawl_queue_items.url = NEW.url
)
BEGIN
  SELECT RAISE(ABORT, 'item completion must remove its queue row before recording terminal state');
END;

CREATE TRIGGER prevent_queue_update_to_terminal_url
BEFORE UPDATE OF crawl_id, url ON crawl_queue_items
WHEN EXISTS (
  SELECT 1
  FROM crawl_terminal_urls
  WHERE crawl_terminal_urls.crawl_id = NEW.crawl_id
    AND crawl_terminal_urls.url = NEW.url
)
BEGIN
  SELECT RAISE(ABORT, 'cannot update a queue item to a terminal crawl URL');
END;

CREATE TRIGGER prevent_terminal_update_to_queue_item
BEFORE UPDATE OF crawl_id, url ON crawl_terminal_urls
WHEN EXISTS (
  SELECT 1
  FROM crawl_queue_items
  WHERE crawl_queue_items.crawl_id = NEW.crawl_id
    AND crawl_queue_items.url = NEW.url
)
BEGIN
  SELECT RAISE(ABORT, 'cannot update terminal state onto a pending crawl URL');
END;

CREATE TRIGGER prevent_queue_for_terminal_crawl
BEFORE INSERT ON crawl_queue_items
WHEN EXISTS (
  SELECT 1
  FROM crawl_runs
  WHERE crawl_runs.id = NEW.crawl_id
    AND crawl_runs.status IN ('completed', 'stopped', 'failed')
)
BEGIN
  SELECT RAISE(ABORT, 'cannot queue work for a terminal crawl');
END;

CREATE TRIGGER prevent_queue_update_to_terminal_crawl
BEFORE UPDATE OF crawl_id ON crawl_queue_items
WHEN EXISTS (
  SELECT 1
  FROM crawl_runs
  WHERE crawl_runs.id = NEW.crawl_id
    AND crawl_runs.status IN ('completed', 'stopped', 'failed')
)
BEGIN
  SELECT RAISE(ABORT, 'cannot move work to a terminal crawl');
END;

CREATE VIRTUAL TABLE pages_fts USING fts5(
  url,
  title,
  description,
  content,
  content='pages',
  content_rowid='id',
  tokenize='porter unicode61'
);

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
