import type { Database } from "bun:sqlite";
import type {
	CrawlCounters,
	CrawlOptions,
	CrawlStatus,
} from "../../contracts/crawl.js";
import {
	type CrawlRunRecord,
	type CrawlRunRow,
	mapCrawlRunRow,
} from "../db.js";

const ZERO_COUNTERS: CrawlCounters = {
	pagesScanned: 0,
	successCount: 0,
	failureCount: 0,
	skippedCount: 0,
	linksFound: 0,
	mediaFiles: 0,
	totalDataKb: 0,
};

interface ListOptions {
	status?: CrawlStatus;
	from?: string;
	to?: string;
	limit?: number;
}

function toSqliteDateTime(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}

	return parsed.toISOString().slice(0, 19).replace("T", " ");
}

export function createCrawlRunRepo(db: Database) {
	const insertRun = db.prepare(`
		INSERT INTO crawl_runs (
			id,
			target,
			status,
			options_json,
			stop_reason,
			pages_scanned,
			success_count,
			failure_count,
			skipped_count,
			links_found,
			media_files,
			total_data_kb
		) VALUES (?, ?, ?, ?, NULL, 0, 0, 0, 0, 0, 0, 0)
	`);

	const getRun = db.prepare("SELECT * FROM crawl_runs WHERE id = ? LIMIT 1");
	const deleteRun = db.prepare("DELETE FROM crawl_runs WHERE id = ?");

	function getById(id: string): CrawlRunRecord | null {
		const row = getRun.get(id) as CrawlRunRow | null;
		return row ? mapCrawlRunRow(row) : null;
	}

	function createRun(
		id: string,
		target: string,
		options: CrawlOptions,
	): CrawlRunRecord {
		insertRun.run(id, target, "pending", JSON.stringify(options));
		const created = getById(id);
		if (!created) {
			throw new Error(`Failed to create crawl run ${id}`);
		}
		return created;
	}

	function updateStatus(
		id: string,
		status: CrawlStatus,
		counters: CrawlCounters,
		stopReason: string | null,
		eventSequence?: number,
		timestamps: { started?: boolean; completed?: boolean } = {},
	): CrawlRunRecord | null {
		db.query(
			`
			UPDATE crawl_runs
			SET
				status = ?,
				stop_reason = ?,
				updated_at = CURRENT_TIMESTAMP,
				started_at = CASE WHEN ? THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
				completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END,
				pages_scanned = ?,
				success_count = ?,
				failure_count = ?,
				skipped_count = ?,
				links_found = ?,
				media_files = ?,
				total_data_kb = ?,
				event_sequence = COALESCE(?, event_sequence)
			WHERE id = ?
		`,
		).run(
			status,
			stopReason,
			timestamps.started ? 1 : 0,
			timestamps.completed ? 1 : 0,
			counters.pagesScanned,
			counters.successCount,
			counters.failureCount,
			counters.skippedCount,
			counters.linksFound,
			counters.mediaFiles,
			counters.totalDataKb,
			eventSequence ?? null,
			id,
		);

		return getById(id);
	}

	function updateProgress(
		id: string,
		counters: CrawlCounters,
		eventSequence?: number,
	): void {
		db.query(
			`
			UPDATE crawl_runs
			SET
				updated_at = CURRENT_TIMESTAMP,
				pages_scanned = ?,
				success_count = ?,
				failure_count = ?,
				skipped_count = ?,
				links_found = ?,
				media_files = ?,
				total_data_kb = ?,
				event_sequence = COALESCE(?, event_sequence)
			WHERE id = ?
		`,
		).run(
			counters.pagesScanned,
			counters.successCount,
			counters.failureCount,
			counters.skippedCount,
			counters.linksFound,
			counters.mediaFiles,
			counters.totalDataKb,
			eventSequence ?? null,
			id,
		);
	}

	function list(options: ListOptions = {}): CrawlRunRecord[] {
		const clauses: string[] = [];
		const params: Array<string | number> = [];

		if (options.status) {
			clauses.push("status = ?");
			params.push(options.status);
		}

		if (options.from) {
			clauses.push("updated_at >= ?");
			params.push(toSqliteDateTime(options.from));
		}

		if (options.to) {
			clauses.push("updated_at <= ?");
			params.push(toSqliteDateTime(options.to));
		}

		const whereClause =
			clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const limit = options.limit ?? 25;

		const rows = db
			.query(
				`SELECT * FROM crawl_runs ${whereClause} ORDER BY updated_at DESC LIMIT ?`,
			)
			.all(...params, limit) as CrawlRunRow[];

		return rows.map(mapCrawlRunRow);
	}

	return {
		createRun,
		deleteRun(id: string): void {
			deleteRun.run(id);
		},
		getById,
		list,
		getInterruptedRuns(limit = 25): CrawlRunRecord[] {
			return list({ status: "interrupted", limit });
		},
		markStarting(
			id: string,
			counters: CrawlCounters = ZERO_COUNTERS,
			eventSequence?: number,
		) {
			return updateStatus(id, "starting", counters, null, eventSequence, {
				started: true,
			});
		},
		markRunning(
			id: string,
			counters: CrawlCounters = ZERO_COUNTERS,
			eventSequence?: number,
		) {
			return updateStatus(id, "running", counters, null, eventSequence, {
				started: true,
			});
		},
		markStopping(
			id: string,
			counters: CrawlCounters,
			stopReason: string | null,
			eventSequence?: number,
		) {
			return updateStatus(id, "stopping", counters, stopReason, eventSequence);
		},
		markCompleted(
			id: string,
			counters: CrawlCounters,
			stopReason: string | null,
			eventSequence?: number,
		) {
			return updateStatus(
				id,
				"completed",
				counters,
				stopReason,
				eventSequence,
				{
					started: true,
					completed: true,
				},
			);
		},
		markStopped(
			id: string,
			counters: CrawlCounters,
			stopReason: string | null,
			eventSequence?: number,
		) {
			return updateStatus(id, "stopped", counters, stopReason, eventSequence, {
				started: true,
				completed: true,
			});
		},
		markFailed(
			id: string,
			counters: CrawlCounters,
			stopReason: string | null,
			eventSequence?: number,
		) {
			return updateStatus(id, "failed", counters, stopReason, eventSequence, {
				started: true,
				completed: true,
			});
		},
		markInterrupted(
			id: string,
			counters: CrawlCounters,
			stopReason: string | null,
			eventSequence?: number,
		) {
			return updateStatus(
				id,
				"interrupted",
				counters,
				stopReason,
				eventSequence,
				{
					started: true,
				},
			);
		},
		updateProgress,
	};
}
