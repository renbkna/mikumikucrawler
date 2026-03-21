CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  url,
  title,
  description,
  content,
  content='pages',
  content_rowid='id',
  tokenize='porter unicode61'
);

INSERT INTO pages_fts(rowid, url, title, description, content)
SELECT id, url, COALESCE(title, ''), COALESCE(description, ''), COALESCE(content, '')
FROM pages
WHERE id NOT IN (SELECT rowid FROM pages_fts);

CREATE TRIGGER IF NOT EXISTS pages_ai
AFTER INSERT ON pages
BEGIN
  INSERT INTO pages_fts(rowid, url, title, description, content)
  VALUES (
    NEW.id,
    NEW.url,
    COALESCE(NEW.title, ''),
    COALESCE(NEW.description, ''),
    COALESCE(NEW.content, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS pages_ad
AFTER DELETE ON pages
BEGIN
  DELETE FROM pages_fts WHERE rowid = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS pages_au
AFTER UPDATE ON pages
BEGIN
  DELETE FROM pages_fts WHERE rowid = OLD.id;
  INSERT INTO pages_fts(rowid, url, title, description, content)
  VALUES (
    NEW.id,
    NEW.url,
    COALESCE(NEW.title, ''),
    COALESCE(NEW.description, ''),
    COALESCE(NEW.content, '')
  );
END;
