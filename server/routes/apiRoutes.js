import express from 'express';

export function setupApiRoutes(dbPromise, activeCrawls, logger) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      activeCrawls: activeCrawls.size,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    });
  });

  router.get('/stats', async (req, res) => {
    try {
      const db = await dbPromise;
      const stats = await db.get(`
        SELECT
          COUNT(*) as totalPages,
          SUM(data_length) as totalDataSize,
          COUNT(DISTINCT domain) as uniqueDomains,
          MAX(crawled_at) as lastCrawled
        FROM pages
      `);

      res.json({
        status: 'ok',
        stats: {
          ...stats,
          activeCrawls: activeCrawls.size,
        },
      });
    } catch (err) {
      logger.error(`Error getting stats: ${err.message}`);
      res.status(500).json({ error: 'Failed to get statistics' });
    }
  });

  return router;
}
