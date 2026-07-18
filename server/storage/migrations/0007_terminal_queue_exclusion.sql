DELETE FROM crawl_queue_items
WHERE EXISTS (
  SELECT 1
  FROM crawl_terminal_urls
  WHERE crawl_terminal_urls.crawl_id = crawl_queue_items.crawl_id
    AND crawl_terminal_urls.url = crawl_queue_items.url
);

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
