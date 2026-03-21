import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import type { CrawlSession } from "../crawler/CrawlSession.js";
import {
	deleteSession,
	getAggregateStats,
	getInterruptedSessions,
	getLanguageStats,
	getPageContentById,
	getQualityDistribution,
	searchPages,
	type LanguageStat,
	type QualityStat,
} from "../data/queries.js";
import type { LoggerLike } from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";

const SessionSummarySchema = t.Object({
	id: t.String(),
	target: t.String(),
	status: t.String(),
	pagesScanned: t.Number(),
	createdAt: t.String(),
	updatedAt: t.String(),
});

const SessionsListResponseSchema = t.Object({
	sessions: t.Array(SessionSummarySchema),
});

const DeleteResponseSchema = t.Object({
	status: t.String(),
});

// Performance optimisation: Cache stats for 30 seconds to reduce database load,
// but bust the cache immediately whenever the number of active crawls changes.
// This keeps the dashboard responsive during active crawls while still shielding
// the DB from polling at full request rate.
const STATS_CACHE_TTL_MS = 30_000;

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
	db: Database,
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

					const combinedStats = getAggregateStats(db);
					const languageStats = getLanguageStats(db);
					const qualityStats = getQualityDistribution(db);

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
			"/sessions",
			({ set }) => {
				try {
					const rows = getInterruptedSessions(db);

					const sessions = rows.map((row) => {
						let pagesScanned = 0;
						if (row.stats) {
							try {
								const parsed = JSON.parse(row.stats) as {
									pagesScanned?: number;
								};
								pagesScanned = parsed.pagesScanned ?? 0;
							} catch (parseErr) {
								// Malformed stats snapshot — skip count, don't fail the request
								logger.debug(
									`Malformed stats JSON for session ${row.id}: ${getErrorMessage(parseErr)}`,
								);
							}
						}
						return {
							id: row.id,
							target: row.target,
							status: row.status,
							pagesScanned,
							createdAt: row.created_at,
							updatedAt: row.updated_at,
						};
					});

					return { sessions };
				} catch (err) {
					const message = getErrorMessage(err);
					logger.error(`Error listing sessions: ${message}`);
					set.status = 500;
					return { error: "Failed to list sessions" };
				}
			},
			{
				detail: {
					tags: ["Sessions"],
					summary: "List interrupted crawl sessions",
					description:
						"Returns all sessions that were interrupted mid-crawl and can be resumed.",
				},
				response: {
					200: SessionsListResponseSchema,
					500: ErrorResponseSchema,
				},
			},
		)
		.delete(
			"/sessions/:id",
			({ params: { id }, set }) => {
				try {
					deleteSession(db, id);
					return { status: "ok" };
				} catch (err) {
					const message = getErrorMessage(err);
					logger.error(`Error deleting session ${id}: ${message}`);
					set.status = 500;
					return { error: "Failed to delete session" };
				}
			},
			{
				params: t.Object({
					id: t.String(),
				}),
				detail: {
					tags: ["Sessions"],
					summary: "Delete an interrupted session",
					description:
						"Permanently removes a session record and its associated pending queue items.",
				},
				response: {
					200: DeleteResponseSchema,
					500: ErrorResponseSchema,
				},
			},
		)
		.get(
			"/search",
			({ query, set }) => {
				const q = typeof query.q === "string" ? query.q.trim() : "";
				if (!q) {
					set.status = 400;
					return { error: "Query parameter 'q' is required" };
				}

				const rawLimit = Number(query.limit ?? 20);
				const limit = Number.isFinite(rawLimit)
					? Math.min(Math.max(rawLimit, 1), 100)
					: 20;

				try {
					// Escape as a quoted phrase so FTS5 special syntax characters
					// (AND, OR, NOT, NEAR, etc.) in user input are treated as literals.
					// Append * for prefix matching so partial words still return results
					// (e.g. "crawl" matches "crawling", "crawler", etc.)
					const escaped = q.replace(/"/g, '""');
					const ftsQuery = `"${escaped}"*`;

					const rows = searchPages(db, ftsQuery, limit);

					return { query: q, count: rows.length, results: rows };
				} catch (err) {
					const message = getErrorMessage(err);
					logger.error(`FTS search error for "${q}": ${message}`);
					set.status = 500;
					return { error: "Search failed" };
				}
			},
			{
				query: t.Object({
					q: t.Optional(t.String()),
					limit: t.Optional(t.String()),
				}),
				detail: {
					tags: ["Search"],
					summary: "Full-text search over crawled pages",
					description:
						"Uses SQLite FTS5 with Porter stemming. Supports prefix matching (partial words) and returns highlighted snippets. Results are ranked by FTS relevance.",
				},
			},
		)
		.get(
			"/pages/:id/content",
			({ params: { id }, set }) => {
				try {
					const content = getPageContentById(db, Number(id));

					if (content === undefined) {
						set.status = 404;
						return { error: "Page not found" };
					}

					return {
						status: "ok",
						content,
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
