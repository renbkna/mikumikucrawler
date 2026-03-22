ALTER TABLE crawl_queue_items
ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS crawl_terminal_urls (
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'skip')),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crawl_id, url),
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crawl_terminal_urls_crawl_id
ON crawl_terminal_urls(crawl_id, recorded_at ASC);

INSERT OR IGNORE INTO crawl_terminal_urls (crawl_id, url, outcome)
SELECT crawl_id, url, 'success'
FROM pages;
