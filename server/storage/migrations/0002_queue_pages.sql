CREATE TABLE IF NOT EXISTS crawl_queue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK(depth >= 0),
  retries INTEGER NOT NULL DEFAULT 0 CHECK(retries >= 0),
  parent_url TEXT,
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE,
  UNIQUE(crawl_id, url)
);

CREATE INDEX IF NOT EXISTS idx_crawl_queue_items_crawl_id
ON crawl_queue_items(crawl_id, created_at ASC);

CREATE TABLE IF NOT EXISTS pages (
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
  media_count INTEGER NOT NULL DEFAULT 0 CHECK(media_count >= 0),
  internal_links_count INTEGER NOT NULL DEFAULT 0 CHECK(internal_links_count >= 0),
  external_links_count INTEGER NOT NULL DEFAULT 0 CHECK(external_links_count >= 0),
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE,
  UNIQUE(crawl_id, url)
);

CREATE INDEX IF NOT EXISTS idx_pages_crawl_id
ON pages(crawl_id, crawled_at DESC);

CREATE INDEX IF NOT EXISTS idx_pages_domain
ON pages(domain);

CREATE TABLE IF NOT EXISTS page_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  target_url TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  nofollow INTEGER NOT NULL DEFAULT 0 CHECK(nofollow IN (0, 1)),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  UNIQUE(page_id, target_url)
);

CREATE INDEX IF NOT EXISTS idx_page_links_page_id
ON page_links(page_id);
