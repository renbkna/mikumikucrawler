import { Elysia, t } from "elysia";
import type { CrawlSession } from "../crawler/CrawlSession.js";
import type { DatabaseLike, LoggerLike } from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";

// Performance optimisation: Cache stats for 30 seconds to reduce database load,
// but bust the cache immediately whenever the number of active crawls changes.
// This keeps the dashboard responsive during active crawls while still shielding
// the DB from polling at full request rate.
const STATS_CACHE_TTL_MS = 30_000;

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

/** Concrete type for the successful stats response — mirrors StatsResponseSchema. */
interface StatsResult {
	status: string;
	stats: {
		totalPages: number | null;
		totalDataSize: number | null;
		uniqueDomains: number | null;
		lastCrawled: string | null;
		activeCrawls: number;
		content: {
			avgWordCount: number;
			avgQualityScore: number;
			avgReadingTime: number;
			totalMedia: number;
			totalInternalLinks: number;
			totalExternalLinks: number;
		};
		languages: LanguageStat[];
		qualityDistribution: QualityStat[];
	};
}

// Elysia response schema types
const StatsResponseSchema = t.Object({
	status: t.String(),
	stats: t.Object({
		totalPages: t.Nullable(t.Number()),
		totalDataSize: t.Nullable(t.Number()),
		uniqueDomains: t.Nullable(t.Number()),
		lastCrawled: t.Nullable(t.String()),
		activeCrawls: t.Number(),
		content: t.Object({
			avgWordCount: t.Number(),
			avgQualityScore: t.Number(),
			avgReadingTime: t.Number(),
			totalMedia: t.Number(),
			totalInternalLinks: t.Number(),
			totalExternalLinks: t.Number(),
		}),
		languages: t.Array(t.Object({ language: t.String(), count: t.Number() })),
		qualityDistribution: t.Array(
			t.Object({ quality_range: t.String(), count: t.Number() }),
		),
	}),
});

const PageContentResponseSchema = t.Object({
	status: t.String(),
	content: t.String(),
});

const ErrorResponseSchema = t.Object({ error: t.String() });

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
	// Cache entry also tracks `activeCrawlsSize` so the cache is busted
	// as soon as a crawl starts or finishes — not just on TTL expiry.
	let statsCache: {
		data: StatsResult;
		timestamp: number;
		activeCrawlsSize: number;
	} | null = null;

	return new Elysia({ name: "api-routes", prefix: "/api" })
		.get(
			"/stats",
			({ set }) => {
				try {
					const now = Date.now();
					const currentActiveCrawls = activeCrawls.size;

					// Return cached stats if within TTL AND active crawl count hasn't changed
					if (
						statsCache &&
						now - statsCache.timestamp < STATS_CACHE_TTL_MS &&
						statsCache.activeCrawlsSize === currentActiveCrawls
					) {
						return statsCache.data;
					}

					// Combined basic and enhanced stats in a single query
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

					// Explicitly pick only the fields that belong in the public response.
					// Spreading `combinedStats` directly would also expose the raw avg*
					// fields from the SQL query alongside the rounded `content.*` versions.
					const result = {
						status: "ok",
						stats: {
							totalPages: combinedStats.totalPages ?? null,
							totalDataSize: combinedStats.totalDataSize ?? null,
							uniqueDomains: combinedStats.uniqueDomains ?? null,
							lastCrawled: combinedStats.lastCrawled ?? null,
							activeCrawls: currentActiveCrawls,
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

					statsCache = {
						data: result,
						timestamp: Date.now(),
						activeCrawlsSize: currentActiveCrawls,
					};

					return result;
				} catch (err) {
					const message = getErrorMessage(err);
					logger.error(`Error getting stats: ${message}`);
					set.status = 500;
					return { error: "Failed to get statistics" };
				}
			},
			{
				detail: {
					tags: ["Stats"],
					summary: "Aggregated crawl statistics",
					description:
						"Returns page counts, data sizes, language distribution, and quality metrics. Cached for 30s; busted on crawl state changes.",
				},
				response: {
					200: StatsResponseSchema,
					500: ErrorResponseSchema,
				},
			},
		)
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
				detail: {
					tags: ["Content"],
					summary: "Fetch raw page content by ID",
					description: "Returns the stored HTML content for a crawled page.",
				},
				response: {
					200: PageContentResponseSchema,
					404: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
			},
		);
}
