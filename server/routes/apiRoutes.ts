import type Database from "better-sqlite3";
import express, { type Request, type Response, type Router } from "express";
import type { Logger } from "winston";
import type { AdvancedCrawlSession } from "../crawler/CrawlSession.js";

interface BasicStats {
	totalPages: number;
	totalDataSize: number;
	uniqueDomains: number;
	lastCrawled: string;
}

interface EnhancedStats {
	avgWordCount: number | null;
	avgQualityScore: number | null;
	avgReadingTime: number | null;
	totalMedia: number | null;
	totalInternalLinks: number | null;
	totalExternalLinks: number | null;
}

interface LanguageStat {
	language: string;
	count: number;
}

interface QualityStat {
	quality_range: string;
	count: number;
}

export function setupApiRoutes(
	dbPromise: Promise<Database.Database>,
	activeCrawls: Map<string, AdvancedCrawlSession>,
	logger: Logger,
): Router {
	const router = express.Router();

	// Note: /health endpoint is defined at root level in server.ts

	router.get("/stats", async (_req: Request, res: Response) => {
		try {
			const db = await dbPromise;

			// better-sqlite3 is synchronous, so we prepare and get/all
			const basicStats = db
				.prepare(`
        SELECT
          COUNT(*) as totalPages,
          SUM(data_length) as totalDataSize,
          COUNT(DISTINCT domain) as uniqueDomains,
          MAX(crawled_at) as lastCrawled
        FROM pages
      `)
				.get() as BasicStats;

			// Enhanced statistics with content processing data
			const enhancedStats = db
				.prepare(`
        SELECT
          AVG(word_count) as avgWordCount,
          AVG(quality_score) as avgQualityScore,
          AVG(reading_time) as avgReadingTime,
          SUM(media_count) as totalMedia,
          SUM(internal_links_count) as totalInternalLinks,
          SUM(external_links_count) as totalExternalLinks
        FROM pages
        WHERE word_count IS NOT NULL
      `)
				.get() as EnhancedStats;

			// Language distribution
			const languageStats = db
				.prepare(`
        SELECT language, COUNT(*) as count
        FROM pages
        WHERE language IS NOT NULL AND language != 'unknown'
        GROUP BY language
        ORDER BY count DESC
        LIMIT 10
      `)
				.all() as LanguageStat[];

			// Quality distribution
			const qualityStats = db
				.prepare(`
        SELECT quality_range, COUNT(*) as count
        FROM (
          SELECT
            CASE
              WHEN quality_score >= 80 THEN 'High (80-100)'
              WHEN quality_score >= 60 THEN 'Medium (60-79)'
              WHEN quality_score >= 40 THEN 'Low (40-59)'
              ELSE 'Poor (0-39)'
            END AS quality_range
          FROM pages
          WHERE quality_score IS NOT NULL
        )
        GROUP BY quality_range
        ORDER BY count DESC
      `)
				.all() as QualityStat[];

			res.json({
				status: "ok",
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
			const message = err instanceof Error ? err.message : "Unknown error";
			logger.error(`Error getting stats: ${message}`);
			res.status(500).json({ error: "Failed to get statistics" });
		}
	});

	router.get("/pages/:id/content", async (req: Request, res: Response) => {
		try {
			const { id } = req.params;

			// Validate that id is a positive integer
			const pageId = Number.parseInt(id, 10);
			if (Number.isNaN(pageId) || pageId <= 0) {
				res.status(400).json({ error: "Invalid page ID" });
				return;
			}

			const db = await dbPromise;

			const page = db
				.prepare("SELECT content FROM pages WHERE id = ?")
				.get(pageId) as { content: string } | undefined;

			if (!page) {
				res.status(404).json({ error: "Page not found" });
				return;
			}

			res.json({
				status: "ok",
				content: page.content,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			logger.error(
				`Error fetching page content for id ${req.params.id}: ${message}`,
			);
			res.status(500).json({ error: "Failed to fetch content" });
		}
	});

	return router;
}
