import axios from "axios";
import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import { URL } from "url";
import { ContentProcessor } from "../../processors/ContentProcessor.js";
import { extractMetadata, getRobotsRules } from "../../utils/helpers.js";
import { extractLinks } from "./linkExtractor.js";

const MEDIA_CONTENT_REGEX = /image|video|audio|application\/(pdf|zip)/i;
const AXIOS_OPTIONS = {
  timeout: 15000,
  maxContentLength: 5 * 1024 * 1024,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate",
  },
};

export function createPagePipeline({
  options,
  state,
  logger,
  socket,
  dbPromise,
  dynamicRenderer,
  queue,
  targetDomain,
}) {
  const contentProcessor = new ContentProcessor(logger);

  const buildFallbackProcessedContent = (error) => ({
    extractedData: { mainContent: "" },
    analysis: {
      wordCount: 0,
      readingTime: 0,
      language: "unknown",
      keywords: [],
      sentiment: "neutral",
      readabilityScore: 0,
      quality: { score: 0, factors: {}, issues: ["Processing failed"] },
    },
    metadata: {},
    media: [],
    links: [],
    errors: error
      ? [{ type: "processor_error", message: error.message }]
      : [],
  });

  const buildEnhancedLog = (item, statusCode, contentLength, processedContent) => {
    const resolvedStatus = Number.isFinite(statusCode) ? statusCode : "n/a";
    const sizeKb = Number.isFinite(contentLength)
      ? Math.max(Math.floor(contentLength / 1024), 0)
      : 0;

    const segments = [
      `[Crawler] Crawled ${item.url} (${resolvedStatus})`,
      `${sizeKb}KB`,
    ];

    if (processedContent.analysis?.wordCount) {
      segments.push(`${processedContent.analysis.wordCount} words`);
    }

    if (
      processedContent.analysis?.language &&
      processedContent.analysis.language !== "unknown"
    ) {
      segments.push(`Lang: ${processedContent.analysis.language}`);
    }

    if (processedContent.analysis?.quality?.score) {
      segments.push(`Quality: ${processedContent.analysis.quality.score}/100`);
    }

    if (processedContent.links?.length) {
      segments.push(`${processedContent.links.length} links`);
    }

    if (processedContent.media?.length) {
      segments.push(`${processedContent.media.length} media`);
    }

    return segments.filter(Boolean).join(" | ");
  };

  const emitStatsUpdate = (log, processedContent, item) => {
    socket.emit("stats", {
      ...state.stats,
      log,
      lastProcessed: {
        url: item.url,
        wordCount: processedContent.analysis?.wordCount || 0,
        qualityScore: processedContent.analysis?.quality?.score || 0,
        language: processedContent.analysis?.language || "unknown",
        mediaCount: processedContent.media?.length || 0,
        linksCount: processedContent.links?.length || 0,
      },
    });
  };

  const emitPageToClient = (page) => {
    socket.emit("pageContent", page);
  };

  const fetchContent = async (item) => {
    let content = "";
    let contentType = "";
    let statusCode = 0;
    let contentLength = 0;
    let title = "";
    let description = "";
    let lastModified = null;
    let isDynamic = false;
    let $ = null;

    const dynamicResult = dynamicRenderer.isEnabled()
      ? await dynamicRenderer.render(item)
      : null;

    if (dynamicResult) {
      content = dynamicResult.content;
      statusCode = dynamicResult.statusCode;
      contentType = dynamicResult.contentType;
      contentLength = dynamicResult.contentLength;
      title = dynamicResult.title;
      description = dynamicResult.description;
      lastModified = dynamicResult.lastModified;
      isDynamic = true;
    }

    if (!content) {
      logger.info(`Using static crawling for ${item.url}`);
      const response = await axios.get(item.url, AXIOS_OPTIONS);
      content = response.data;
      statusCode = response.status;
      contentType = response.headers["content-type"] || "";
      contentLength = parseInt(response.headers["content-length"] || "0", 10);
      lastModified = response.headers["last-modified"];
    }

    if (contentType.includes("text/html")) {
      $ = cheerio.load(content);
      const metadata = extractMetadata($);
      if (!title) {
        title = metadata.title;
      }
      if (!description) {
        description = metadata.description;
      }
    }

    if (!contentLength && content) {
      contentLength = Buffer.byteLength(content, "utf8");
    }

    return {
      content,
      $,
      statusCode,
      contentType,
      contentLength,
      title,
      description,
      lastModified,
      isDynamic,
    };
  };

  const storePageRecord = ({
    db,
    item,
    domain,
    content,
    sanitizedContent,
    contentType,
    statusCode,
    contentLength,
    title,
    description,
    isDynamic,
    lastModified,
    processedContent,
  }) => {
    const enhancedData = {
      mainContent: processedContent.extractedData?.mainContent || "",
      wordCount: processedContent.analysis?.wordCount || 0,
      readingTime: processedContent.analysis?.readingTime || 0,
      language: processedContent.analysis?.language || "unknown",
      keywords: JSON.stringify(processedContent.analysis?.keywords || []),
      qualityScore: processedContent.analysis?.quality?.score || 0,
      structuredData: JSON.stringify(processedContent.extractedData || {}),
      mediaCount: processedContent.media?.length || 0,
      internalLinksCount:
        processedContent.links?.filter((link) => link.isInternal)?.length || 0,
      externalLinksCount:
        processedContent.links?.filter((link) => !link.isInternal)?.length || 0,
    };

    db.prepare(
      `INSERT INTO pages
        (url, domain, content_type, status_code, data_length, title, description, content, is_dynamic, last_modified,
         main_content, word_count, reading_time, language, keywords, quality_score, structured_data,
         media_count, internal_links_count, external_links_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          domain = excluded.domain,
          content_type = excluded.content_type,
          status_code = excluded.status_code,
          data_length = excluded.data_length,
          title = excluded.title,
          description = excluded.description,
          content = excluded.content,
          is_dynamic = excluded.is_dynamic,
          last_modified = excluded.last_modified,
          main_content = excluded.main_content,
          word_count = excluded.word_count,
          reading_time = excluded.reading_time,
          language = excluded.language,
          keywords = excluded.keywords,
          quality_score = excluded.quality_score,
          structured_data = excluded.structured_data,
          media_count = excluded.media_count,
          internal_links_count = excluded.internal_links_count,
          external_links_count = excluded.external_links_count,
          crawled_at = CURRENT_TIMESTAMP`
    ).run(
      item.url,
      domain,
      contentType,
      statusCode,
      contentLength,
      title,
      description,
      options.contentOnly ? null : sanitizedContent,
      isDynamic ? 1 : 0,
      lastModified,
      enhancedData.mainContent,
      enhancedData.wordCount,
      enhancedData.readingTime,
      enhancedData.language,
      enhancedData.keywords,
      enhancedData.qualityScore,
      enhancedData.structuredData,
      enhancedData.mediaCount,
      enhancedData.internalLinksCount,
      enhancedData.externalLinksCount
    );

    const pageRow = db.prepare(`SELECT id FROM pages WHERE url = ?`).get(item.url);
    return pageRow?.id ?? null;
  };

  const handleLinkPersistence = (db, pageId, links) => {
    if (!links.length || !pageId) {
      return;
    }

    const insertStmt = db.prepare(
      "INSERT OR IGNORE INTO links (source_id, target_url, text) VALUES (?, ?, ?)"
    );

    const transaction = db.transaction((links) => {
      for (const link of links) {
        try {
          insertStmt.run(pageId, link.url, link.text || "");
        } catch (err) {
          logger.warn(`Failed to insert link: ${err.message}`);
        }
      }
    });

    transaction(links);
  };

  const enqueueLinksWithPolicies = async (links, item, domain) => {
    if (!links.length || item.depth >= options.crawlDepth - 1) {
      return;
    }

    const filteredLinks = links.filter((link) => !state.hasVisited(link.url));
    if (!filteredLinks.length) {
      return;
    }

    if (!options.respectRobots) {
      filteredLinks.forEach((link) => {
        queue.enqueue({
          url: link.url,
          depth: item.depth + 1,
          retries: 0,
          parentUrl: item.url,
        });
      });
      return;
    }

    for (const link of filteredLinks) {
      try {
        const linkUrl = new URL(link.url);
        const linkDomain = linkUrl.hostname;

        if (linkDomain !== domain && linkDomain !== targetDomain) {
          const robots = await getRobotsRules(linkDomain, dbPromise, logger);
          if (robots && !robots.isAllowed(link.url, "MikuCrawler")) {
            logger.debug(`Skipping ${link.url} - disallowed by robots.txt`);
            state.recordSkip();
            continue;
          }

          const crawlDelay = robots?.getCrawlDelay?.("MikuCrawler");
          if (crawlDelay) {
            const delayMs = Math.max(crawlDelay * 1000, options.crawlDelay);
            state.setDomainDelay(linkDomain, delayMs);
          } else {
            state.setDomainDelay(linkDomain, options.crawlDelay);
          }
        }

        queue.enqueue({
          url: link.url,
          depth: item.depth + 1,
          retries: 0,
          parentUrl: item.url,
        });
      } catch (err) {
        logger.debug(`Error processing link ${link.url}: ${err.message}`);
      }
    }
  };

  return async function processItem(item) {
    if (!state.canProcessMore()) {
      return;
    }

    if (state.hasVisited(item.url)) {
      return;
    }

    logger.info(`Fetching: ${item.url}`);

    let fetchResult;
    try {
      fetchResult = await fetchContent(item);
    } catch (error) {
      state.recordFailure();
      logger.error(`Error fetching ${item.url}: ${error.message}`);
      socket.emit("stats", {
        ...state.stats,
        log: `[Crawler] Error fetching ${item.url}: ${error.message}`,
      });

      if (item.retries < options.retryLimit && state.isActive) {
        const retries = item.retries + 1;
        const backoffDelay = Math.min(1000 * Math.pow(2, retries), 30000);
        logger.info(
          `Retrying ${item.url} in ${backoffDelay}ms (attempt ${retries}/${options.retryLimit})`
        );
        queue.scheduleRetry({ ...item, retries }, backoffDelay);
      }
      return;
    }

    const {
      content,
      $,
      statusCode,
      contentType,
      contentLength,
      title,
      description,
      lastModified,
      isDynamic,
    } = fetchResult;

    state.markVisited(item.url);
    state.recordSuccess(contentLength);

    const url = new URL(item.url);
    const domain = url.hostname;

    let processedContent;
    try {
      processedContent = await contentProcessor.processContent(
        content,
        item.url,
        contentType
      );
    } catch (error) {
      logger.error(`ContentProcessor failed for ${item.url}: ${error.message}`);
      processedContent = buildFallbackProcessedContent(error);
    }

    const db = await dbPromise;

    const sanitizedContent = contentType.includes("text/html")
      ? sanitizeHtml(content, {
          allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
          allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            "*": ["class", "id", "style"],
          },
        })
      : content;

    const pageId = await storePageRecord({
      db,
      item,
      domain,
      content,
      sanitizedContent,
      contentType,
      statusCode,
      contentLength,
      title,
      description,
      isDynamic,
      lastModified,
      processedContent,
    });

    let links = [];
    if (contentType.includes("text/html")) {
      const parser = $ || cheerio.load(content);
      links = extractLinks(parser, item.url, options);
      state.addLinks(links.length);
      handleLinkPersistence(db, pageId, links);
    }


    if (
      options.saveMedia &&
      (options.crawlMethod === "media" || options.crawlMethod === "full") &&
      contentType.match(MEDIA_CONTENT_REGEX)
    ) {
      state.addMedia(1);
    }

    const logMessage = buildEnhancedLog(item, statusCode, contentLength, processedContent);
    emitStatsUpdate(logMessage, processedContent, item);

    emitPageToClient({
      url: item.url,
      content: sanitizedContent,
      title,
      description,
      contentType,
      domain,
      processedData: {
        extractedData: processedContent.extractedData || {},
        metadata: processedContent.metadata || {},
        analysis: processedContent.analysis || {},
        media: processedContent.media || [],
        qualityScore: processedContent.analysis?.quality?.score || 0,
        keywords: processedContent.analysis?.keywords || [],
        language: processedContent.analysis?.language || "unknown",
      },
    });

    await enqueueLinksWithPolicies(links, item, domain);

  };
}
