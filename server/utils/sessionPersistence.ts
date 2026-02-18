import type { Database } from "bun:sqlite";
import type { CrawlStats, QueueItem, SanitizedCrawlOptions } from "../types.js";
import { getErrorMessage } from "./helpers.js";

export type SessionStatus = "running" | "completed" | "interrupted";

// ─── Session CRUD ──────────────────────────────────────────────────────────────

/**
 * Creates a new crawl session record in the DB.
 * Called at the start of every CrawlSession.start() so we can resume later.
 */
export function saveSession(
	db: Database,
	sessionId: string,
	socketId: string,
	options: SanitizedCrawlOptions,
): void {
	try {
		db.query(
			`INSERT OR REPLACE INTO crawl_sessions (id, socket_id, target, options, status, updated_at)
			 VALUES (?, ?, ?, ?, 'running', CURRENT_TIMESTAMP)`,
		).run(sessionId, socketId, options.target, JSON.stringify(options));
	} catch {
		// Session persistence is best-effort — never abort a crawl
	}
}

/**
 * Persists a stats snapshot for the session (called periodically during crawling).
 */
export function updateSessionStats(
	db: Database,
	sessionId: string,
	stats: CrawlStats,
): void {
	try {
		db.query(
			`UPDATE crawl_sessions SET stats = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		).run(JSON.stringify(stats), sessionId);
	} catch {
		// Non-fatal
	}
}

/**
 * Updates the lifecycle status of a session.
 */
export function updateSessionStatus(
	db: Database,
	sessionId: string,
	status: SessionStatus,
): void {
	try {
		db.query(
			`UPDATE crawl_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		).run(status, sessionId);
	} catch {
		// Non-fatal
	}
}

/**
 * Loads a session's options and stats by ID.
 * Returns null if the session doesn't exist.
 */
export function loadSession(
	db: Database,
	sessionId: string,
): { options: SanitizedCrawlOptions; stats: CrawlStats | null; status: SessionStatus } | null {
	try {
		const row = db
			.query(
				`SELECT options, stats, status FROM crawl_sessions WHERE id = ? LIMIT 1`,
			)
			.get(sessionId) as
			| { options: string; stats: string | null; status: string }
			| undefined;

		if (!row) return null;

		const options = JSON.parse(row.options) as SanitizedCrawlOptions;
		const stats = row.stats ? (JSON.parse(row.stats) as CrawlStats) : null;
		const status = row.status as SessionStatus;
		return { options, stats, status };
	} catch (err) {
		// biome-ignore lint/suspicious/noConsole: Error logging for session load failure
		console.error(`Failed to load session ${sessionId}: ${getErrorMessage(err)}`);
		return null;
	}
}

// ─── Queue Item CRUD ───────────────────────────────────────────────────────────

const _insertQueueItem = (db: Database) =>
	db.prepare(
		`INSERT OR IGNORE INTO queue_items (session_id, url, depth, retries, parent_url, domain)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);

/**
 * Saves a batch of queue items in a single transaction for efficiency.
 */
export function saveQueueItemBatch(
	db: Database,
	sessionId: string,
	items: QueueItem[],
): void {
	if (items.length === 0) return;
	try {
		const stmt = _insertQueueItem(db);
		const tx = db.transaction(() => {
			for (const item of items) {
				stmt.run(
					sessionId,
					item.url,
					item.depth,
					item.retries,
					item.parentUrl ?? null,
					item.domain,
				);
			}
		});
		tx();
	} catch {
		// Non-fatal
	}
}

/**
 * Removes a queue item once it has been successfully processed.
 */
export function removeQueueItem(
	db: Database,
	sessionId: string,
	url: string,
): void {
	try {
		db.query(
			`DELETE FROM queue_items WHERE session_id = ? AND url = ?`,
		).run(sessionId, url);
	} catch {
		// Non-fatal
	}
}

/**
 * Loads all pending (not-yet-processed) queue items for a session.
 * Used when resuming an interrupted crawl.
 */
export function loadPendingQueueItems(
	db: Database,
	sessionId: string,
): QueueItem[] {
	try {
		const rows = db
			.query(
				`SELECT url, depth, retries, parent_url, domain
				 FROM queue_items
				 WHERE session_id = ?
				 ORDER BY depth ASC`,
			)
			.all(sessionId) as {
			url: string;
			depth: number;
			retries: number;
			parent_url: string | null;
			domain: string;
		}[];

		return rows.map((row) => ({
			url: row.url,
			depth: row.depth,
			retries: row.retries,
			parentUrl: row.parent_url ?? undefined,
			domain: row.domain,
		}));
	} catch {
		return [];
	}
}
