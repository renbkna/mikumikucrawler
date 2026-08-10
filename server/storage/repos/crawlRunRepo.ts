import type { Database } from "bun:sqlite";
import type {
	CrawlOptions,
	CrawlStatus,
	ResumableCrawlStatus,
} from "../../../shared/contracts/index.js";
import {
	DEFAULT_CRAWL_LIST_LIMIT,
	isCrawlOptions,
	isTerminalCrawlStatus,
} from "../../../shared/contracts/index.js";
import { normalizeCanonicalHttpUrl } from "../../../shared/url.js";
import { type CrawlRunRecord, type CrawlRunRow, mapCrawlRunRow, type OwnStatement } from "../db.js";

type ResumableCrawlRunRecord = CrawlRunRecord & {
	status: ResumableCrawlStatus;
	resumable: true;
};

interface ListOptions {
	status?: CrawlStatus;
	from?: string;
	to?: string;
	limit?: number;
}

function toSqliteDateTime(value: string, bound: "lower" | "upper"): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}

	const milliseconds = parsed.getTime();
	const roundedMilliseconds =
		bound === "lower"
			? Math.ceil(milliseconds / 1_000) * 1_000
			: Math.floor(milliseconds / 1_000) * 1_000;
	return new Date(roundedMilliseconds).toISOString().slice(0, 19).replace("T", " ");
}

export function createCrawlRunRepo(db: Database, own: OwnStatement) {
	const insertRun = own(
		db.prepare(`
		INSERT INTO crawl_runs (
			id,
			status,
			options_json
		) VALUES (?, ?, ?)
	`),
	);

	const getRun = own(db.prepare("SELECT * FROM crawl_runs WHERE id = ? LIMIT 1"));
	const deleteRun = own(db.prepare("DELETE FROM crawl_runs WHERE id = ?"));
	const insertInitialQueueItem = own(
		db.prepare(`
		INSERT INTO crawl_queue_items (
			crawl_id, url, depth, retries, parent_url, domain, available_at
		) VALUES (?, ?, 0, 0, NULL, ?, 0)
	`),
	);
	const clearQueue = own(db.prepare("DELETE FROM crawl_queue_items WHERE crawl_id = ?"));
	const clearTerminalUrls = own(db.prepare("DELETE FROM crawl_terminal_urls WHERE crawl_id = ?"));
	const clearDomainState = own(db.prepare("DELETE FROM crawl_domain_state WHERE crawl_id = ?"));
	const listActiveRuns = own(
		db.prepare(`
		SELECT *
		FROM crawl_runs
		WHERE status IN ('pending', 'starting', 'running', 'pausing', 'stopping')
		ORDER BY updated_at DESC
	`),
	);
	const listResumableRuns = own(
		db.prepare(`
		SELECT *
		FROM crawl_runs
		WHERE status IN ('paused', 'interrupted')
		ORDER BY updated_at DESC
		LIMIT ?
	`),
	);

	function getById(id: string): CrawlRunRecord | null {
		const row = getRun.get(id) as CrawlRunRow | null;
		return row ? mapCrawlRunRow(row) : null;
	}

	const createRunTransaction = db.transaction((id: string, options: CrawlOptions) => {
		insertRun.run(id, "pending", JSON.stringify(options));
		insertInitialQueueItem.run(id, options.target, new URL(options.target).hostname);
	});

	function createRun(id: string, options: CrawlOptions): CrawlRunRecord {
		if (!isCrawlOptions(options)) {
			throw new Error("Cannot persist crawl options outside the current contract");
		}
		const normalizedTarget = normalizeCanonicalHttpUrl(options.target);
		if ("error" in normalizedTarget) {
			throw new Error(`Cannot persist invalid crawl target: ${normalizedTarget.error}`);
		}
		const normalizedOptions = { ...options, target: normalizedTarget.url };
		createRunTransaction(id, normalizedOptions);
		const created = getById(id);
		if (!created) {
			throw new Error(`Failed to create crawl run ${id}`);
		}
		return created;
	}

	function updateStatus(
		id: string,
		status: CrawlStatus,
		stopReason: string | null,
		eventSequence?: number,
		timestamps: { started?: boolean; completed?: boolean } = {},
	): CrawlRunRecord | null {
		db.transaction(() => {
			db.query(
				`
			UPDATE crawl_runs
			SET
				status = ?,
				stop_reason = ?,
				updated_at = CURRENT_TIMESTAMP,
				started_at = CASE WHEN ? THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
				completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END,
				event_sequence = COALESCE(?, event_sequence)
			WHERE id = ?
		`,
			).run(
				status,
				stopReason,
				timestamps.started ? 1 : 0,
				timestamps.completed ? 1 : 0,
				eventSequence ?? null,
				id,
			);
			if (isTerminalCrawlStatus(status)) {
				clearQueue.run(id);
				clearTerminalUrls.run(id);
				clearDomainState.run(id);
			}
		})();

		return getById(id);
	}

	function updateProgress(id: string, eventSequence?: number): void {
		db.query(
			`
			UPDATE crawl_runs
			SET
				updated_at = CURRENT_TIMESTAMP,
				event_sequence = COALESCE(?, event_sequence)
			WHERE id = ?
		`,
		).run(eventSequence ?? null, id);
	}

	function advanceEventSequence(id: string, eventSequence: number): void {
		if (!Number.isSafeInteger(eventSequence) || eventSequence < 1) {
			throw new Error("Event sequence must be a positive safe integer");
		}
		const result = db
			.query(`
				UPDATE crawl_runs
				SET event_sequence = ?, updated_at = CURRENT_TIMESTAMP
				WHERE id = ? AND event_sequence <= ?
			`)
			.run(eventSequence, id, eventSequence);
		if (result.changes !== 1) {
			throw new Error(`Cannot advance event sequence for crawl ${id}`);
		}
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
			params.push(toSqliteDateTime(options.from, "lower"));
		}

		if (options.to) {
			clauses.push("updated_at <= ?");
			params.push(toSqliteDateTime(options.to, "upper"));
		}

		const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const limit = options.limit ?? DEFAULT_CRAWL_LIST_LIMIT;

		const rows = db
			.query(`SELECT * FROM crawl_runs ${whereClause} ORDER BY updated_at DESC LIMIT ?`)
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
		listActive(): CrawlRunRecord[] {
			return (listActiveRuns.all() as CrawlRunRow[]).map(mapCrawlRunRow);
		},
		getResumableRuns(limit = DEFAULT_CRAWL_LIST_LIMIT): ResumableCrawlRunRecord[] {
			return (listResumableRuns.all(limit) as CrawlRunRow[]).map(
				mapCrawlRunRow,
			) as ResumableCrawlRunRecord[];
		},
		markStarting(id: string, eventSequence?: number) {
			return updateStatus(id, "starting", null, eventSequence, {
				started: true,
			});
		},
		markRunning(id: string, eventSequence?: number) {
			return updateStatus(id, "running", null, eventSequence, {
				started: true,
			});
		},
		markStopping(id: string, stopReason: string | null, eventSequence?: number) {
			return updateStatus(id, "stopping", stopReason, eventSequence);
		},
		markPausing(id: string, stopReason: string | null, eventSequence?: number) {
			return updateStatus(id, "pausing", stopReason, eventSequence);
		},
		markPaused(id: string, stopReason: string | null, eventSequence?: number) {
			return updateStatus(id, "paused", stopReason, eventSequence, {
				started: true,
			});
		},
		markCompleted(id: string, stopReason: string | null, eventSequence?: number) {
			return updateStatus(id, "completed", stopReason, eventSequence, {
				started: true,
				completed: true,
			});
		},
		markStopped(id: string, stopReason: string | null, eventSequence?: number) {
			return updateStatus(id, "stopped", stopReason, eventSequence, {
				started: true,
				completed: true,
			});
		},
		markFailed(id: string, stopReason: string | null, eventSequence?: number) {
			return updateStatus(id, "failed", stopReason, eventSequence, {
				started: true,
				completed: true,
			});
		},
		markInterrupted(id: string, stopReason: string | null, eventSequence?: number) {
			return updateStatus(id, "interrupted", stopReason, eventSequence, {
				started: true,
			});
		},
		advanceEventSequence,
		updateProgress,
	};
}
