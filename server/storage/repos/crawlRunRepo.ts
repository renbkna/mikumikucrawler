import type { Database } from "bun:sqlite";
import {
	ACTIVE_CRAWL_STATUS_VALUES,
	type CrawlCounters,
	type CrawlOptions,
	type CrawlStatus,
	type CrawlSummary,
	isCrawlCounters,
	isCrawlOptions,
	isResumableCrawlStatus,
	isTerminalCrawlStatus,
	RESUMABLE_CRAWL_STATUS_VALUES,
	type ResumableCrawlListResponse,
} from "../../../shared/contracts/index.js";
import { bytesToKilobytes } from "../../../shared/text.js";
import { normalizeCanonicalHttpUrl } from "../../../shared/url.js";
import { canonicalizeStorageDateTime } from "../dateTime.js";
import { sqlTextList } from "../sql.js";
import type { createCrawlQueueRepo } from "./crawlQueueRepo.js";

type ResumableCrawlSummary = ResumableCrawlListResponse["crawls"][number];
type TransitionStatus = Exclude<CrawlStatus, "pending">;

/** Durable timestamps each lifecycle transition establishes. */
const TRANSITION_TIMESTAMPS: Record<TransitionStatus, { started: boolean; completed: boolean }> = {
	starting: { started: true, completed: false },
	running: { started: true, completed: false },
	pausing: { started: false, completed: false },
	stopping: { started: false, completed: false },
	paused: { started: true, completed: false },
	interrupted: { started: true, completed: false },
	completed: { started: true, completed: true },
	stopped: { started: true, completed: true },
	failed: { started: true, completed: true },
};

interface ListOptions {
	status?: CrawlStatus;
	from?: string;
	to?: string;
	limit: number;
}

/** The counter columns shared by every crawl_runs projection. */
export interface CrawlCounterColumns {
	pages_scanned: number;
	success_count: number;
	failure_count: number;
	skipped_count: number;
	links_found: number;
	media_files: number;
	total_data_bytes: number;
}

interface CrawlRunRow extends CrawlCounterColumns {
	id: string;
	status: CrawlStatus;
	stop_reason: string | null;
	options_json: string;
	created_at: string;
	started_at: string | null;
	updated_at: string;
	completed_at: string | null;
	event_sequence: number;
}

export function countersFromColumns(row: CrawlCounterColumns): CrawlCounters {
	return {
		pagesScanned: row.pages_scanned,
		successCount: row.success_count,
		failureCount: row.failure_count,
		skippedCount: row.skipped_count,
		linksFound: row.links_found,
		mediaFiles: row.media_files,
		totalDataKb: bytesToKilobytes(row.total_data_bytes),
	};
}

function requireIsoDateTime(crawlId: string, value: string): string {
	const canonical = canonicalizeStorageDateTime(value);
	if (!canonical) {
		throw new Error(
			`Crawl run ${crawlId} has a timestamp outside the date-time contract: ${value}`,
		);
	}
	return canonical;
}

function mapCrawlRunRow(row: CrawlRunRow): CrawlSummary {
	let options: unknown;
	try {
		options = JSON.parse(row.options_json);
	} catch (error) {
		throw new Error(`Crawl run ${row.id} contains invalid options JSON`, { cause: error });
	}
	if (!isCrawlOptions(options)) {
		throw new Error(`Crawl run ${row.id} contains options outside the current contract`);
	}
	const counters = countersFromColumns(row);
	if (!isCrawlCounters(counters)) {
		throw new Error(`Crawl run ${row.id} contains invalid counters`);
	}
	if (!Number.isSafeInteger(row.event_sequence) || row.event_sequence < 0) {
		throw new Error(`Crawl run ${row.id} contains an invalid event sequence`);
	}
	const optionalDateTime = (value: string | null) =>
		value === null ? null : requireIsoDateTime(row.id, value);

	return {
		id: row.id,
		target: options.target,
		status: row.status,
		options,
		stopReason: row.stop_reason,
		createdAt: requireIsoDateTime(row.id, row.created_at),
		startedAt: optionalDateTime(row.started_at),
		updatedAt: requireIsoDateTime(row.id, row.updated_at),
		completedAt: optionalDateTime(row.completed_at),
		counters,
		eventSequence: row.event_sequence,
		resumable: isResumableCrawlStatus(row.status),
	};
}

function requireResumable(crawl: CrawlSummary): ResumableCrawlSummary {
	if (!isResumableCrawlStatus(crawl.status) || !crawl.resumable) {
		throw new Error(`Crawl run ${crawl.id} is not resumable`);
	}
	return { ...crawl, status: crawl.status, resumable: true };
}

/** Converts an RFC 3339 filter bound to SQLite's second-precision CURRENT_TIMESTAMP text. */
function toSqliteDateTime(value: string, bound: "lower" | "upper"): string {
	const milliseconds = Date.parse(value);
	if (Number.isNaN(milliseconds)) {
		throw new Error(`Crawl list bound is not a date-time: ${value}`);
	}
	const rounded =
		bound === "lower"
			? Math.ceil(milliseconds / 1_000) * 1_000
			: Math.floor(milliseconds / 1_000) * 1_000;
	return new Date(rounded).toISOString().slice(0, 19).replace("T", " ");
}

export function createCrawlRunRepo(
	db: Database,
	queue: Pick<ReturnType<typeof createCrawlQueueRepo>, "enqueueMany" | "clear">,
) {
	const insertRun = db.prepare<never, [string, string, string]>(
		"INSERT INTO crawl_runs (id, status, options_json) VALUES (?, ?, ?)",
	);
	const getRun = db.prepare<CrawlRunRow, [string]>("SELECT * FROM crawl_runs WHERE id = ? LIMIT 1");
	const deleteRun = db.prepare<never, [string]>("DELETE FROM crawl_runs WHERE id = ?");
	const clearTerminalUrls = db.prepare<never, [string]>(
		"DELETE FROM crawl_terminal_urls WHERE crawl_id = ?",
	);
	const clearDomainState = db.prepare<never, [string]>(
		"DELETE FROM crawl_domain_state WHERE crawl_id = ?",
	);
	const listActiveRuns = db.prepare<CrawlRunRow, []>(`
		SELECT *
		FROM crawl_runs
		WHERE status IN (${sqlTextList(ACTIVE_CRAWL_STATUS_VALUES)})
		ORDER BY updated_at DESC
	`);
	const listResumableRuns = db.prepare<CrawlRunRow, [number]>(`
		SELECT *
		FROM crawl_runs
		WHERE status IN (${sqlTextList(RESUMABLE_CRAWL_STATUS_VALUES)})
		ORDER BY updated_at DESC
		LIMIT ?
	`);
	const updateStatus = db.prepare<
		never,
		[TransitionStatus, string | null, number, number, number | null, string]
	>(`
		UPDATE crawl_runs
		SET
			status = ?,
			stop_reason = ?,
			updated_at = CURRENT_TIMESTAMP,
			started_at = CASE WHEN ? THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
			completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END,
			event_sequence = COALESCE(?, event_sequence)
		WHERE id = ?
	`);
	const advanceSequence = db.prepare<never, [number, string, number]>(`
		UPDATE crawl_runs
		SET event_sequence = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND event_sequence <= ?
	`);

	function getById(id: string): CrawlSummary | null {
		const row = getRun.get(id);
		return row ? mapCrawlRunRow(row) : null;
	}

	function requireById(id: string): CrawlSummary {
		const crawl = getById(id);
		if (!crawl) throw new Error(`Crawl run ${id} does not exist`);
		return crawl;
	}

	const createRunTransaction = db.transaction((id: string, options: CrawlOptions) => {
		insertRun.run(id, "pending", JSON.stringify(options));
		queue.enqueueMany(id, [
			{
				url: options.target,
				depth: 0,
				retries: 0,
				domain: new URL(options.target).hostname,
				availableAt: 0,
			},
		]);
	});

	const transitionTransaction = db.transaction(
		(
			id: string,
			status: TransitionStatus,
			stopReason: string | null,
			eventSequence: number | null,
		) => {
			const timestamps = TRANSITION_TIMESTAMPS[status];
			const result = updateStatus.run(
				status,
				stopReason,
				timestamps.started ? 1 : 0,
				timestamps.completed ? 1 : 0,
				eventSequence,
				id,
			);
			if (result.changes !== 1) throw new Error(`Crawl run ${id} does not exist`);
			if (isTerminalCrawlStatus(status)) {
				queue.clear(id);
				clearTerminalUrls.run(id);
				clearDomainState.run(id);
			}
		},
	);

	return {
		createRun(id: string, options: CrawlOptions): CrawlSummary {
			if (!isCrawlOptions(options)) {
				throw new Error("Cannot persist crawl options outside the current contract");
			}
			const normalizedTarget = normalizeCanonicalHttpUrl(options.target);
			if ("error" in normalizedTarget) {
				throw new Error(`Cannot persist invalid crawl target: ${normalizedTarget.error}`);
			}
			createRunTransaction(id, { ...options, target: normalizedTarget.url });
			return requireById(id);
		},
		deleteRun(id: string): void {
			deleteRun.run(id);
		},
		getById,
		list(options: ListOptions): CrawlSummary[] {
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
			return db
				.query<CrawlRunRow, Array<string | number>>(
					`SELECT * FROM crawl_runs ${whereClause} ORDER BY updated_at DESC LIMIT ?`,
				)
				.all(...params, options.limit)
				.map(mapCrawlRunRow);
		},
		listActive(): CrawlSummary[] {
			return listActiveRuns.all().map(mapCrawlRunRow);
		},
		listResumable(limit: number): ResumableCrawlSummary[] {
			return listResumableRuns.all(limit).map(mapCrawlRunRow).map(requireResumable);
		},
		/**
		 * Moves an existing run to `status`. Terminal statuses also discard the run's
		 * queue, terminal-URL, and scheduler state in the same transaction.
		 */
		transition(
			id: string,
			status: TransitionStatus,
			change: { stopReason?: string | null; eventSequence?: number } = {},
		): CrawlSummary {
			transitionTransaction(id, status, change.stopReason ?? null, change.eventSequence ?? null);
			return requireById(id);
		},
		advanceEventSequence(id: string, eventSequence: number): void {
			if (!Number.isSafeInteger(eventSequence) || eventSequence < 1) {
				throw new Error("Event sequence must be a positive safe integer");
			}
			if (advanceSequence.run(eventSequence, id, eventSequence).changes !== 1) {
				throw new Error(`Cannot advance event sequence for crawl ${id}`);
			}
		},
	};
}
