CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  stop_reason TEXT,
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  links_found INTEGER NOT NULL DEFAULT 0,
  media_files INTEGER NOT NULL DEFAULT 0,
  total_data_kb INTEGER NOT NULL DEFAULT 0,
  event_sequence INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_crawl_runs_status_updated_at
ON crawl_runs(status, updated_at DESC);
