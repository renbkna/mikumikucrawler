ALTER TABLE crawl_queue_items
ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0 CHECK(available_at >= 0);

CREATE TABLE IF NOT EXISTS crawl_terminal_urls (
  terminal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'skip')),
  domain_budget_charged INTEGER NOT NULL DEFAULT 0 CHECK(domain_budget_charged IN (0, 1)),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (crawl_id, url),
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crawl_terminal_urls_crawl_id
ON crawl_terminal_urls(crawl_id, terminal_sequence ASC);

INSERT OR IGNORE INTO crawl_terminal_urls (crawl_id, url, outcome, domain_budget_charged)
SELECT crawl_id, url, 'success', 1
FROM pages;
