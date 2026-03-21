import type { Database } from "bun:sqlite";

export function createStatsRepo(db: Database) {
	return {
		getAggregate() {
			return db
				.query(
					`
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
				`,
				)
				.get();
		},
	};
}
