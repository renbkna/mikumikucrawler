import type { Database } from "bun:sqlite";
import type {
	CrawlStats,
	LoggerLike,
	QueueItem,
	SanitizedCrawlOptions,
} from "../types.js";
import { getErrorMessage } from "./helpers.js";

export type SessionStatus = "running" | "completed" | "interrupted";

export function saveSession(
	db: Database,
	sessionId: string,
	socketId: string,
	options: SanitizedCrawlOptions,
	logger?: LoggerLike,
): void {
	try {
		db.query(
			`INSERT OR REPLACE INTO crawl_sessions (id, socket_id, target, options, status, updated_at)
			 VALUES (?, ?, ?, ?, 'running', CURRENT_TIMESTAMP)`,
		).run(sessionId, socketId, options.target, JSON.stringify(options));
	} catch (err) {
		logger?.debug(
			`Failed to save session ${sessionId}: ${getErrorMessage(err)}`,
		);
	}
}

/**
 * Persists a stats snapshot for the session (called periodically during crawling).
 */
export function updateSessionStats(
	db: Database,
	sessionId: string,
	stats: CrawlStats,
	logger?: LoggerLike,
): void {
	try {
		db.query(
			`UPDATE crawl_sessions SET stats = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		).run(JSON.stringify(stats), sessionId);
	} catch (err) {
		logger?.debug(
			`Failed to update session stats for ${sessionId}: ${getErrorMessage(err)}`,
		);
	}
}

export function updateSessionStatus(
	db: Database,
	sessionId: string,
	status: SessionStatus,
	logger?: LoggerLike,
): void {
	try {
		db.query(
			`UPDATE crawl_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		).run(status, sessionId);
	} catch (err) {
		logger?.debug(
			`Failed to update session status for ${sessionId}: ${getErrorMessage(err)}`,
		);
	}
}

export function loadSession(
	db: Database,
	sessionId: string,
	logger?: LoggerLike,
): {
	options: SanitizedCrawlOptions;
	stats: CrawlStats | null;
	status: SessionStatus;
} | null {
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
		const msg = `Failed to load session ${sessionId}: ${getErrorMessage(err)}`;
		if (logger) {
			logger.error(msg);
		} else {
			// biome-ignore lint/suspicious/noConsole: Logger unavailable during early session load
			console.error(msg);
		}
		return null;
	}
}

const _insertQueueItem = (db: Database) =>
	db.prepare(
		`INSERT OR IGNORE INTO queue_items (session_id, url, depth, retries, parent_url, domain)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);

export function saveQueueItemBatch(
	db: Database,
	sessionId: string,
	items: QueueItem[],
	logger?: LoggerLike,
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
	} catch (err) {
		logger?.debug(
			`Failed to save queue items for ${sessionId}: ${getErrorMessage(err)}`,
		);
	}
}

export function removeQueueItem(
	db: Database,
	sessionId: string,
	url: string,
	logger?: LoggerLike,
): void {
	try {
		db.query(`DELETE FROM queue_items WHERE session_id = ? AND url = ?`).run(
			sessionId,
			url,
		);
	} catch (err) {
		logger?.debug(
			`Failed to remove queue item ${url}: ${getErrorMessage(err)}`,
		);
	}
}

export function loadPendingQueueItems(
	db: Database,
	sessionId: string,
	logger?: LoggerLike,
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
	} catch (err) {
		logger?.debug(
			`Failed to load queue items for ${sessionId}: ${getErrorMessage(err)}`,
		);
		return [];
	}
}
