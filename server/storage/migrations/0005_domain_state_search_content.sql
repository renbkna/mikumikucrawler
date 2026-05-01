CREATE TABLE IF NOT EXISTS crawl_domain_state (
  crawl_id TEXT NOT NULL,
  delay_key TEXT NOT NULL,
  delay_ms INTEGER NOT NULL CHECK(delay_ms >= 0),
  next_allowed_at INTEGER NOT NULL CHECK(next_allowed_at >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crawl_id, delay_key),
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crawl_domain_state_crawl_id
ON crawl_domain_state(crawl_id, delay_key);

ALTER TABLE pages
ADD COLUMN discovered_links_count INTEGER NOT NULL DEFAULT 0 CHECK(discovered_links_count >= 0);

DROP TRIGGER IF EXISTS pages_ai;
DROP TRIGGER IF EXISTS pages_ad;
DROP TRIGGER IF EXISTS pages_au;

DELETE FROM pages_fts;

INSERT INTO pages_fts(rowid, url, title, description, content)
SELECT
  id,
  url,
  COALESCE(title, ''),
  COALESCE(description, ''),
  COALESCE(NULLIF(main_content, ''), NULLIF(content, ''), '')
FROM pages;

CREATE TRIGGER IF NOT EXISTS pages_ai
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

CREATE TRIGGER IF NOT EXISTS pages_ad
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

CREATE TRIGGER IF NOT EXISTS pages_au
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
