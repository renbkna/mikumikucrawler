import type { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { t } from "elysia";
import type { SocketCrawledPage } from "../../src/types/socket.js";
import type { Logger } from "../config/logging.js";
import { WEBSOCKET_RATE_LIMIT } from "../constants.js";
import { CrawlSession } from "../crawler/CrawlSession.js";
import {
	getLinksBySourceId,
	getPageByUrl,
	getPagesPaginated,
} from "../data/queries.js";
import type {
	ClampOptions,
	CrawlerSocket,
	RawCrawlOptions,
	SanitizedCrawlOptions,
} from "../types.js";
import { assertPublicHostname } from "../utils/validation.js";

const ALLOWED_CRAWL_METHODS = new Set(["links", "content", "media", "full"]);
const ALLOWED_EXPORT_FORMATS = new Set(["json", "csv"]);

/** Rate limiter for WebSocket messages per socket */
class WebSocketRateLimiter {
	private messageCounts = new Map<string, number[]>();
	private lastCleanup = 0;

	canProceed(socketId: string): boolean {
		const now = Date.now();
		if (now - this.lastCleanup > 60_000) {
			this.lastCleanup = now;
			this.cleanup();
		}
		const windowStart = now - WEBSOCKET_RATE_LIMIT.WINDOW_MS;

		// Get or create message timestamps for this socket
		let timestamps = this.messageCounts.get(socketId) || [];

		// Remove old timestamps outside the window
		timestamps = timestamps.filter((ts) => ts > windowStart);

		// Check if under limit
		if (timestamps.length >= WEBSOCKET_RATE_LIMIT.MAX_MESSAGES_PER_MINUTE) {
			return false;
		}

		// Add current timestamp
		timestamps.push(now);
		this.messageCounts.set(socketId, timestamps);
		return true;
	}

	cleanup(): void {
		const now = Date.now();
		const windowStart = now - WEBSOCKET_RATE_LIMIT.WINDOW_MS;

		for (const [socketId, timestamps] of this.messageCounts) {
			const filtered = timestamps.filter((ts) => ts > windowStart);
			if (filtered.length === 0) {
				this.messageCounts.delete(socketId);
			} else {
				this.messageCounts.set(socketId, filtered);
			}
		}
	}
}

/** Regex to detect CSV injection characters at start of cell values */
const CSV_INJECTION_REGEX = /^[=+\-@|\t]/;

/**
 * Ensures a number stays within specified bounds, falling back to a default if invalid.
 */
function clampNumber(
	value: unknown,
	{ min, max, fallback }: ClampOptions,
): number {
	const parsed = Number(value);
	if (Number.isNaN(parsed)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** Sanitizes and validates crawl options provided by the client. */
export async function sanitizeOptions(
	rawOptions: RawCrawlOptions = {},
): Promise<SanitizedCrawlOptions> {
	const targetInput =
		typeof rawOptions.target === "string" ? rawOptions.target.trim() : "";
	if (!targetInput) {
		throw new Error("Target URL is required");
	}

	let normalizedTarget = targetInput;
	if (!/^https?:\/\//i.test(normalizedTarget)) {
		normalizedTarget = `http://${normalizedTarget}`;
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(normalizedTarget);
	} catch {
		throw new Error("Target must be a valid URL");
	}

	if (!["http:", "https:"].includes(parsedUrl.protocol)) {
		throw new Error("Only HTTP and HTTPS targets are supported");
	}

	await assertPublicHostname(parsedUrl.hostname);

	const crawlDepth = clampNumber(rawOptions.crawlDepth, {
		min: 1,
		max: 5,
		fallback: 2,
	});
	const maxPages = clampNumber(rawOptions.maxPages, {
		min: 1,
		max: 200,
		fallback: 50,
	});
	const crawlDelay = clampNumber(rawOptions.crawlDelay, {
		min: 200,
		max: 10000,
		fallback: 1000,
	});
	const maxConcurrentRequests = clampNumber(rawOptions.maxConcurrentRequests, {
		min: 1,
		max: 10,
		fallback: 5,
	});
	const retryLimit = clampNumber(rawOptions.retryLimit, {
		min: 0,
		max: 5,
		fallback: 3,
	});

	const method =
		typeof rawOptions.crawlMethod === "string"
			? rawOptions.crawlMethod.toLowerCase()
			: "links";
	const crawlMethod = ALLOWED_CRAWL_METHODS.has(method)
		? (method as SanitizedCrawlOptions["crawlMethod"])
		: "links";

	const maxPagesPerDomain = clampNumber(rawOptions.maxPagesPerDomain, {
		min: 0,
		max: 1000,
		fallback: 0,
	});

	return {
		target: parsedUrl.toString(),
		crawlDepth,
		maxPages,
		maxPagesPerDomain,
		crawlDelay,
		crawlMethod,
		maxConcurrentRequests,
		retryLimit,
		dynamic: rawOptions.dynamic !== false,
		respectRobots: rawOptions.respectRobots !== false,
		contentOnly: Boolean(rawOptions.contentOnly),
		saveMedia:
			rawOptions.saveMedia === true ||
			crawlMethod === "media" ||
			crawlMethod === "full",
	};
}

export const WebSocketMessageSchema = t.Object({
	type: t.String(),
	data: t.Optional(t.Any()),
});

type WebSocketMessage = typeof WebSocketMessageSchema.static;

/**
 * Tracks active export operations per socket to prevent race conditions.
 * Root cause fix: Each export gets a unique request ID, and we track
 * which export operation is currently active per socket.
 */
interface ExportOperation {
	requestId: string;
	format: string;
	startTime: number;
}

/** Creates the WebSocket message handler logic for crawler interactions. */
export function createWebSocketHandlers(
	activeCrawls: Map<string, CrawlSession>,
	db: Database,
	logger: Logger,
) {
	// Root cause fix: Track active exports per socket to prevent race conditions
	const activeExports = new Map<string, ExportOperation>();
	const rateLimiter = new WebSocketRateLimiter();

	const handleMessage = async (
		ws: {
			id: string;
			send(data: string | object): number;
			data: { id: string };
		},
		message: WebSocketMessage,
	) => {
		const socketWrapper: CrawlerSocket = {
			id: ws.data.id || ws.id,
			emit: (event, ...args) => {
				ws.send({ type: event, data: args[0] });
			},
		};

		// Check rate limit
		if (!rateLimiter.canProceed(socketWrapper.id)) {
			logger.warn(`Rate limit exceeded for socket ${socketWrapper.id}`);
			socketWrapper.emit("crawlError", {
				message: "Rate limit exceeded. Please slow down.",
			});
			return;
		}

		// Validate message type
		if (!message.type || typeof message.type !== "string") {
			logger.warn(`Invalid message type from socket ${socketWrapper.id}`);
			return;
		}

		switch (message.type) {
			case "startAttack": {
				// Runtime validation: ensure message.data is an object
				if (!message.data || typeof message.data !== "object") {
					socketWrapper.emit("crawlError", {
						message: "Invalid crawl options format",
					});
					return;
				}
				const options = message.data as RawCrawlOptions;
				const existingSession = activeCrawls.get(socketWrapper.id);
				if (existingSession) {
					await existingSession.stop();
				}

				let validatedOptions: SanitizedCrawlOptions;
				try {
					validatedOptions = await sanitizeOptions(options);
				} catch (validationError) {
					const message =
						validationError instanceof Error
							? validationError.message
							: "Invalid options";
					logger.warn(
						`Invalid crawl options from ${socketWrapper.id}: ${message}`,
					);
					socketWrapper.emit("crawlError", { message });
					return;
				}

				logger.info(
					`Starting new crawl session for ${socketWrapper.id} with target: ${validatedOptions.target}`,
				);

				const crawlSession = new CrawlSession(
					socketWrapper,
					validatedOptions,
					db,
					logger,
				);
				activeCrawls.set(socketWrapper.id, crawlSession);
				crawlSession.start();
				break;
			}

			case "stopAttack": {
				logger.info(`Stopping crawl session for ${socketWrapper.id}`);
				const session = activeCrawls.get(socketWrapper.id);
				if (session) {
					await session.stop();
					activeCrawls.delete(socketWrapper.id);
				}
				break;
			}

			case "getPageDetails": {
				// Runtime validation: ensure message.data is a valid URL string
				if (typeof message.data !== "string") {
					socketWrapper.emit("crawlError", {
						message: "Invalid URL format",
					});
					return;
				}
				const url = message.data;
				// Validate URL length (prevent DoS with extremely long strings)
				if (!url || url.length > 2000) {
					socketWrapper.emit("crawlError", {
						message: "Invalid URL",
					});
					return;
				}
				try {
					const pageRecord = getPageByUrl(db, url);

					if (pageRecord && pageRecord.id !== null) {
						const links = getLinksBySourceId(db, pageRecord.id);

						socketWrapper.emit("pageDetails", {
							...pageRecord,
							links,
						} as SocketCrawledPage);
					} else {
						socketWrapper.emit("pageDetails", null);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					logger.error(`Error getting page details: ${message}`);
					socketWrapper.emit("crawlError", {
						message: "Failed to get page details",
					});
				}
				break;
			}

			case "exportData": {
				// Runtime validation: ensure message.data is a valid format string
				const format = message.data;
				if (format !== undefined && typeof format !== "string") {
					socketWrapper.emit("crawlError", {
						message: 'Invalid export format. Use "json" or "csv".',
					});
					return;
				}

				const sanitizedFormat =
					typeof format === "string" ? format.toLowerCase().trim() : "";

				if (!ALLOWED_EXPORT_FORMATS.has(sanitizedFormat)) {
					socketWrapper.emit("crawlError", {
						message: 'Invalid export format. Use "json" or "csv".',
					});
					return;
				}

				// Root cause fix: Check if there's already an active export for this socket
				const existingExport = activeExports.get(socketWrapper.id);
				if (existingExport) {
					logger.warn(
						`Export already in progress for socket ${socketWrapper.id}, rejecting new request`,
					);
					socketWrapper.emit("crawlError", {
						message: "An export is already in progress. Please wait.",
					});
					return;
				}

				// Root cause fix: Generate unique request ID for this export operation
				const requestId = crypto.randomUUID();
				const exportOp: ExportOperation = {
					requestId,
					format: sanitizedFormat,
					startTime: Date.now(),
				};
				activeExports.set(socketWrapper.id, exportOp);

				try {
					// Root cause fix: Include requestId in all export messages
					socketWrapper.emit("exportStart", {
						format: sanitizedFormat,
						requestId,
					});

					const CHUNK_SIZE = 500;
					let chunk: string[] = [];
					let isFirstChunk = true;
					let rowCount = 0;
					let lastId = 0;

					if (sanitizedFormat === "json") {
						socketWrapper.emit("exportChunk", {
							data: "[",
							requestId,
						});
					}

					const escapeCsvCell = (value: unknown): string => {
						if (value === null || value === undefined) return '""';
						let stringValue: string;
						if (typeof value === "object") {
							stringValue = JSON.stringify(value);
						} else if (typeof value === "string") {
							stringValue = value;
						} else {
							stringValue = String(
								value as string | number | boolean | bigint | symbol,
							);
						}

						// Prepend single quote if cell starts with dangerous characters
						// to prevent Formula Injection in Excel/Sheets.
						if (CSV_INJECTION_REGEX.test(stringValue)) {
							stringValue = `'${stringValue}`;
						}
						stringValue = stringValue.replaceAll('"', '""');
						return `"${stringValue}"`;
					};

					// Keyset pagination: O(1) per page vs OFFSET which is O(n)
					while (true) {
						const rows = getPagesPaginated(db, lastId, CHUNK_SIZE);

						if (rows.length === 0) break;
						lastId = rows[rows.length - 1].id;

						for (const rowObj of rows) {
							rowCount++;

							if (sanitizedFormat === "csv" && isFirstChunk && rowCount === 1) {
								const csvHeaders = Object.keys(rowObj).join(",");
								socketWrapper.emit("exportChunk", {
									data: `${csvHeaders}\n`,
									requestId,
								});
							}

							if (sanitizedFormat === "json") {
								const prefix: string =
									!isFirstChunk || chunk.length > 0 ? "," : "";
								chunk.push(prefix + JSON.stringify(rowObj, null, 2));
							} else {
								const csvRow = Object.keys(rowObj)
									.map((key) => escapeCsvCell(rowObj[key]))
									.join(",");
								chunk.push(csvRow);
							}
						}

						if (chunk.length > 0) {
							const data =
								sanitizedFormat === "json"
									? chunk.join("")
									: `${chunk.join("\n")}\n`;
							socketWrapper.emit("exportChunk", { data, requestId });
							chunk = [];
							isFirstChunk = false;
						}

						if (rows.length < CHUNK_SIZE) break;
						await new Promise((resolve) => setImmediate(resolve));
					}

					if (sanitizedFormat === "json") {
						socketWrapper.emit("exportChunk", { data: "]", requestId });
					}

					// Root cause fix: Include requestId in completion message
					socketWrapper.emit("exportComplete", { count: rowCount, requestId });
					logger.info(
						`Export completed for socket ${socketWrapper.id}: ${rowCount} rows in ${Date.now() - exportOp.startTime}ms`,
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					logger.error(`Error exporting data: ${message}`);
					// requestId is always assigned at this point (line 291)
					socketWrapper.emit("crawlError", {
						message: "Failed to export data",
						requestId,
					});
				} finally {
					// Root cause fix: Clean up active export tracking
					activeExports.delete(socketWrapper.id);
				}
				break;
			}
		}
	};

	const handleClose = async (ws: { id: string; data: { id: string } }) => {
		const id = ws.data.id || ws.id;

		// Root cause fix: Clean up any active export for this socket
		activeExports.delete(id);

		const session = activeCrawls.get(id);
		if (session) {
			await session.stop();
			activeCrawls.delete(id);
		}
		logger.info(`Client disconnected: ${id}`);
	};

	return { handleMessage, handleClose };
}
