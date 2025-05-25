import { AdvancedCrawlSession } from '../crawler/CrawlSession.js';

export function setupSocketHandlers(io, dbPromise, logger) {
  const activeCrawls = new Map();

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);
    let crawlSession = null;

    socket.on('startAttack', (options) => {
      if (crawlSession) {
        crawlSession.stop();
      }

      logger.info(
        `Starting new crawl session for ${socket.id} with target: ${options.target}`
      );

      // Validate all options coming from client
      const validated = {
        target: options.target,
        crawlDepth: options.crawlDepth,
        maxPages: options.maxPages,
        crawlDelay: options.crawlDelay,
        crawlMethod: options.crawlMethod,
        maxConcurrentRequests: options.maxConcurrentRequests,
        retryLimit: options.retryLimit,
        dynamic: options.dynamic !== false,
        respectRobots: options.respectRobots !== false,
        contentOnly: options.contentOnly || false,
      };

      crawlSession = new AdvancedCrawlSession(
        socket,
        validated,
        dbPromise,
        logger
      );
      activeCrawls.set(socket.id, crawlSession);
      crawlSession.start();
    });

    socket.on('stopAttack', () => {
      logger.info(`Stopping crawl session for ${socket.id}`);
      if (crawlSession) {
        crawlSession.stop();
        activeCrawls.delete(socket.id);
        crawlSession = null;
      }
    });

    socket.on('getPageDetails', async (url) => {
      try {
        if (!url) return;

        const db = await dbPromise;
        const page = await db.get(`SELECT * FROM pages WHERE url = ?`, url);

        if (page) {
          const links = await db.all(
            `SELECT * FROM links WHERE source_id = ?`,
            page.id
          );

          socket.emit('pageDetails', { ...page, links });
        } else {
          socket.emit('pageDetails', null);
        }
      } catch (err) {
        logger.error(`Error getting page details: ${err.message}`);
        socket.emit('error', { message: 'Failed to get page details' });
      }
    });

    socket.on('exportData', async (format) => {
      try {
        const db = await dbPromise;
        const pages =
          await db.all(`SELECT id, url, domain, crawled_at, status_code,
                                   data_length, title, description FROM pages`);

        let result;
        if (format === 'json') {
          result = JSON.stringify(pages, null, 2);
        } else if (format === 'csv') {
          // Simple CSV conversion
          const headers = Object.keys(pages[0] || {}).join(',');
          const rows = pages
            .map((page) => Object.values(page).join(','))
            .join('\n');
          result = headers + '\n' + rows;
        } else {
          throw new Error('Unsupported export format');
        }

        socket.emit('exportResult', { data: result, format });
      } catch (err) {
        logger.error(`Error exporting data: ${err.message}`);
        socket.emit('error', { message: 'Failed to export data' });
      }
    });

    socket.on('disconnect', () => {
      if (crawlSession) {
        crawlSession.stop();
        activeCrawls.delete(socket.id);
      }
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  return activeCrawls;
}
