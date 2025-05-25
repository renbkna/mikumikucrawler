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
      const basicStats = await db.get(`
        SELECT
          COUNT(*) as totalPages,
          SUM(data_length) as totalDataSize,
          COUNT(DISTINCT domain) as uniqueDomains,
          MAX(crawled_at) as lastCrawled
        FROM pages
      `);

      // Enhanced statistics with content processing data
      const enhancedStats = await db.get(`
        SELECT
          AVG(word_count) as avgWordCount,
          AVG(quality_score) as avgQualityScore,
          AVG(reading_time) as avgReadingTime,
          SUM(media_count) as totalMedia,
          SUM(internal_links_count) as totalInternalLinks,
          SUM(external_links_count) as totalExternalLinks
        FROM pages
        WHERE word_count IS NOT NULL
      `);

      // Language distribution
      const languageStats = await db.all(`
        SELECT language, COUNT(*) as count
        FROM pages
        WHERE language IS NOT NULL AND language != 'unknown'
        GROUP BY language
        ORDER BY count DESC
        LIMIT 10
      `);

      // Quality distribution
      const qualityStats = await db.all(`
        SELECT
          CASE
            WHEN quality_score >= 80 THEN 'High (80-100)'
            WHEN quality_score >= 60 THEN 'Medium (60-79)'
            WHEN quality_score >= 40 THEN 'Low (40-59)'
            ELSE 'Poor (0-39)'
          END as quality_range,
          COUNT(*) as count
        FROM pages
        WHERE quality_score IS NOT NULL
        GROUP BY quality_range
        ORDER BY quality_score DESC
      `);

      res.json({
        status: 'ok',
        stats: {
          ...basicStats,
          activeCrawls: activeCrawls.size,
          // Enhanced content statistics
          content: {
            avgWordCount: Math.round(enhancedStats.avgWordCount || 0),
            avgQualityScore: Math.round(enhancedStats.avgQualityScore || 0),
            avgReadingTime: Math.round(enhancedStats.avgReadingTime || 0),
            totalMedia: enhancedStats.totalMedia || 0,
            totalInternalLinks: enhancedStats.totalInternalLinks || 0,
            totalExternalLinks: enhancedStats.totalExternalLinks || 0,
          },
          languages: languageStats,
          qualityDistribution: qualityStats,
        },
      });
    } catch (err) {
      logger.error(`Error getting stats: ${err.message}`);
      res.status(500).json({ error: 'Failed to get statistics' });
    }
  });

  return router;
}
