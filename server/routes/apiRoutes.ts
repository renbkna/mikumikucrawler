import { Elysia, t } from "elysia";
import type { CrawlSession } from "../crawler/CrawlSession.js";
import type { DatabaseLike, LoggerLike } from "../types.js";

interface RouteContext {
	db: DatabaseLike;
	logger: LoggerLike;
	activeCrawls: Map<string, CrawlSession>;
	error: (code: number, response: unknown) => unknown;
}

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

/** REST API routes for retrieving system-wide statistics and specific page content. */
export const apiRoutes = new Elysia({ prefix: "/api" })
	.get("/stats", (context) => {
		const { db, activeCrawls, error, logger } =
			context as unknown as RouteContext;
		try {
			const basicStats = db
				.query(`
					SELECT
						COUNT(*) as totalPages,
						SUM(data_length) as totalDataSize,
						COUNT(DISTINCT domain) as uniqueDomains,
						MAX(crawled_at) as lastCrawled
					FROM pages
				`)
				.get() as BasicStats;

			const enhancedStats = db
				.query(`
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

			const languageStats = db
				.query(`
					SELECT language, COUNT(*) as count
					FROM pages
					WHERE language IS NOT NULL AND language != 'unknown'
					GROUP BY language
					ORDER BY count DESC
					LIMIT 10
				`)
				.all() as LanguageStat[];

			const qualityStats = db
				.query(`
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

			return {
				status: "ok",
				stats: {
					...basicStats,
					activeCrawls: activeCrawls.size,
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
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			logger.error(`Error getting stats: ${message}`);
			return error(500, { error: "Failed to get statistics" });
		}
	})
	.get(
		"/pages/:id/content",
		(context) => {
			const {
				params: { id },
				db,
				error,
				logger,
			} = context as unknown as RouteContext & { params: { id: number } };
			try {
				const page = db
					.query("SELECT content FROM pages WHERE id = ?")
					.get(id) as { content: string } | undefined;

				if (!page) {
					return error(404, { error: "Page not found" });
				}

				return {
					status: "ok",
					content: page.content,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				logger.error(`Error fetching page content for id ${id}: ${message}`);
				return error(500, { error: "Failed to fetch content" });
			}
		},
		{
			params: t.Object({
				id: t.Numeric(),
			}),
		},
	);
