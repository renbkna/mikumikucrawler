CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crawl_runs (
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
  pages_scanned INTEGER NOT NULL DEFAULT 0 CHECK(pages_scanned >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK(success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK(skipped_count >= 0),
  links_found INTEGER NOT NULL DEFAULT 0 CHECK(links_found >= 0),
  media_files INTEGER NOT NULL DEFAULT 0 CHECK(media_files >= 0),
  total_data_kb INTEGER NOT NULL DEFAULT 0 CHECK(total_data_kb >= 0),
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(event_sequence >= 0),
  CHECK(pages_scanned = success_count + failure_count + skipped_count)
);

CREATE INDEX IF NOT EXISTS idx_crawl_runs_status_updated_at
ON crawl_runs(status, updated_at DESC);
