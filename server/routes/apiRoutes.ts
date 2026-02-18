import { Elysia, t } from "elysia";
import type { CrawlSession } from "../crawler/CrawlSession.js";
import type { DatabaseLike, LoggerLike } from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";

// Performance optimisation: Cache stats for 60 seconds to reduce database load.
// Kept in factory closure rather than module scope so each app instance has
// its own cache (important for testing and future multi-tenant use).
const STATS_CACHE_TTL_MS = 60_000;

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

/**
 * Creates the REST API routes plugin with the given shared dependencies.
 * Using a factory avoids `context as unknown` casts and makes the dependency
 * graph explicit and fully type-safe.
 */
export function createApiRoutes(
	db: DatabaseLike,
	logger: LoggerLike,
	activeCrawls: Map<string, CrawlSession>,
) {
	let statsCache: { data: unknown; timestamp: number } | null = null;

	return new Elysia({ prefix: "/api" })
		.get("/stats", ({ set }) => {
			try {
				// Return cached stats if within TTL
				const now = Date.now();
				if (statsCache && now - statsCache.timestamp < STATS_CACHE_TTL_MS) {
					return statsCache.data;
				}

				// Optimised: Combined basic and enhanced stats into single query
				const combinedStats = db
					.query(`
						SELECT
							COUNT(*) as totalPages,
							SUM(data_length) as totalDataSize,
							COUNT(DISTINCT domain) as uniqueDomains,
							MAX(crawled_at) as lastCrawled,
							AVG(word_count) as avgWordCount,
							AVG(quality_score) as avgQualityScore,
							AVG(reading_time) as avgReadingTime,
							SUM(media_count) as totalMedia,
							SUM(internal_links_count) as totalInternalLinks,
							SUM(external_links_count) as totalExternalLinks
						FROM pages
					`)
					.get() as BasicStats & EnhancedStats;

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

				const result = {
					status: "ok",
					stats: {
						...combinedStats,
						activeCrawls: activeCrawls.size,
						content: {
							avgWordCount: Math.round(combinedStats.avgWordCount || 0),
							avgQualityScore: Math.round(combinedStats.avgQualityScore || 0),
							avgReadingTime: Math.round(combinedStats.avgReadingTime || 0),
							totalMedia: combinedStats.totalMedia || 0,
							totalInternalLinks: combinedStats.totalInternalLinks || 0,
							totalExternalLinks: combinedStats.totalExternalLinks || 0,
						},
						languages: languageStats,
						qualityDistribution: qualityStats,
					},
				};

				statsCache = { data: result, timestamp: Date.now() };

				return result;
			} catch (err) {
				const message = getErrorMessage(err);
				logger.error(`Error getting stats: ${message}`);
				set.status = 500;
				return { error: "Failed to get statistics" };
			}
		})
		.get(
			"/pages/:id/content",
			({ params: { id }, set }) => {
				try {
					const page = db
						.query("SELECT content FROM pages WHERE id = ?")
						.get(id) as { content: string } | undefined;

					if (!page) {
						set.status = 404;
						return { error: "Page not found" };
					}

					return {
						status: "ok",
						content: page.content,
					};
				} catch (err) {
					const message = getErrorMessage(err);
					logger.error(`Error fetching page content for id ${id}: ${message}`);
					set.status = 500;
					return { error: "Failed to fetch content" };
				}
			},
			{
				params: t.Object({
					id: t.Numeric(),
				}),
			},
		);
}
