import type { Database } from "bun:sqlite";
import { t } from "elysia";
import type { SocketCrawledPage } from "../../src/types/socket.js";
import type { Logger } from "../config/logging.js";
import {
	EXPORT_CONSTANTS,
	REQUEST_CONSTANTS,
	WEBSOCKET_RATE_LIMIT,
} from "../constants.js";
import { CrawlSession } from "../crawler/CrawlSession.js";
import type {
	ClampOptions,
	CrawledPage,
	CrawlerSocket,
	RawCrawlOptions,
	SanitizedCrawlOptions,
} from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";
import { assertPublicHostname } from "../utils/validation.js";

const ALLOWED_CRAWL_METHODS = new Set(["links", "media", "full"]);
const ALLOWED_EXPORT_FORMATS = new Set(["json", "csv"]);

/** Rate limiter for WebSocket messages per socket */
class WebSocketRateLimiter {
	private messageCounts = new Map<string, number[]>();

	canProceed(socketId: string): boolean {
		const now = Date.now();
		const windowStart = now - WEBSOCKET_RATE_LIMIT.WINDOW_MS;

		// Get or create message timestamps for this socket
		let timestamps = this.messageCounts.get(socketId) ?? [];

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

	/** Immediately removes all data for a specific socket on disconnect */
	removeSocket(socketId: string): void {
		this.messageCounts.delete(socketId);
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
		max: 10,
		fallback: 2,
	});
	const maxPages = clampNumber(rawOptions.maxPages, {
		min: 1,
		max: 200,
		fallback: 50,
	});
	// 0 means unlimited; positive values cap pages per domain
	const maxPagesPerDomain = clampNumber(rawOptions.maxPagesPerDomain, {
		min: 0,
		max: 200,
		fallback: 0,
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
 * Each export gets a unique request ID to identify active operations.
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
	// Track active exports per socket to prevent race conditions
	const activeExports = new Map<string, ExportOperation>();
	const rateLimiter = new WebSocketRateLimiter();

	// Periodic cleanup of rate limiter data.
	// Store the handle so it can be cleared on shutdown via dispose().
	const cleanupInterval = setInterval(() => rateLimiter.cleanup(), 60_000);

	/** Call this on server shutdown to release the cleanup interval. */
	const dispose = (): void => {
		clearInterval(cleanupInterval);
	};

	const handleMessage = async (
		ws: {
			id: string;
			send(data: string | object): number;
		},
		message: WebSocketMessage,
	) => {
		const socketWrapper: CrawlerSocket = {
			id: ws.id,
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
					// Use a distinct name to avoid shadowing the outer `message` parameter
					const errMsg =
						validationError instanceof Error
							? validationError.message
							: "Invalid options";
					logger.warn(
						`Invalid crawl options from ${socketWrapper.id}: ${errMsg}`,
					);
					socketWrapper.emit("crawlError", { message: errMsg });
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

			case "resumeSession": {
				const resumeData = message.data as { sessionId?: unknown };
				const sessionId = resumeData?.sessionId;
				if (!sessionId || typeof sessionId !== "string") {
					socketWrapper.emit("crawlError", {
						message: "Invalid session ID for resume",
					});
					break;
				}
				const existing = activeCrawls.get(socketWrapper.id);
				if (existing) {
					await existing.stop();
					activeCrawls.delete(socketWrapper.id);
				}
				const resumed = CrawlSession.resume(sessionId, socketWrapper, db, logger);
				if (!resumed) {
					socketWrapper.emit("crawlError", {
						message: `Session ${sessionId} not found or not resumable`,
					});
					break;
				}
				activeCrawls.set(socketWrapper.id, resumed);
				resumed.start();
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
				if (!url || url.length > REQUEST_CONSTANTS.MAX_URL_LENGTH) {
					socketWrapper.emit("crawlError", {
						message: "Invalid URL",
					});
					return;
				}
				try {
					const pageRecord = db
						.query(`
							SELECT id, url, content, title, description, content_type, domain
							FROM pages
							WHERE url = ?
						`)
						.get(url) as
						| {
								id: number;
								url: string;
								content: string;
								title: string;
								description: string;
								content_type: string;
								domain: string;
						  }
						| undefined;

					if (pageRecord) {
						const links = db
							.query(`SELECT target_url, text FROM links WHERE source_id = ?`)
							.all(pageRecord.id);

						const mappedPage: CrawledPage = {
							id: pageRecord.id,
							url: pageRecord.url,
							content: pageRecord.content,
							title: pageRecord.title,
							description: pageRecord.description,
							contentType: pageRecord.content_type,
							domain: pageRecord.domain,
						};

						const mappedLinks = (
							links as { target_url: string; text: string }[]
						).map((l) => ({
							url: l.target_url,
							text: l.text,
						}));

						socketWrapper.emit("pageDetails", {
							...mappedPage,
							links: mappedLinks,
						} as SocketCrawledPage);
					} else {
						socketWrapper.emit("pageDetails", null);
					}
				} catch (err) {
					const errMsg = getErrorMessage(err);
					logger.error(`Error getting page details: ${errMsg}`);
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

				// Check if there's already an active export for this socket
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

				// Generate unique request ID for this export operation
				const requestId = Bun.randomUUIDv7();
				const exportOp: ExportOperation = {
					requestId,
					format: sanitizedFormat,
					startTime: Date.now(),
				};
				activeExports.set(socketWrapper.id, exportOp);

				try {
					const rows = db
						.query(
							`SELECT id, url, domain, crawled_at, status_code,
                                       data_length, title, description FROM pages`,
						)
						.all() as Record<string, unknown>[];

					// Include requestId in all export messages
					socketWrapper.emit("exportStart", {
						format: sanitizedFormat,
						requestId,
					});

					const CHUNK_SIZE = EXPORT_CONSTANTS.CHUNK_SIZE;
					let chunk: string[] = [];
					let isFirstChunk = true;
					let rowCount = 0;

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
							// rowCount was already incremented above, so row 1 → no comma,
							// all subsequent rows → leading comma (streaming JSON array).
							const prefix = rowCount > 1 ? "," : "";
							chunk.push(prefix + JSON.stringify(rowObj, null, 2));
						} else {
							const csvRow = Object.keys(rowObj)
								.map((key) => escapeCsvCell(rowObj[key]))
								.join(",");
							chunk.push(csvRow);
						}

						if (chunk.length >= CHUNK_SIZE) {
							const data =
								sanitizedFormat === "json"
									? chunk.join("")
									: `${chunk.join("\n")}\n`;
							socketWrapper.emit("exportChunk", { data, requestId });
							chunk = [];
							isFirstChunk = false;
							// Yield to the event loop between chunks to avoid blocking WS I/O
							await Bun.sleep(0);
						}
					}

					if (chunk.length > 0) {
						const data =
							sanitizedFormat === "json"
								? chunk.join("")
								: `${chunk.join("\n")}\n`;
						socketWrapper.emit("exportChunk", { data, requestId });
					}

					if (sanitizedFormat === "json") {
						socketWrapper.emit("exportChunk", { data: "]", requestId });
					}

					// Include requestId in completion message
					socketWrapper.emit("exportComplete", { count: rowCount, requestId });
					logger.info(
						`Export completed for socket ${socketWrapper.id}: ${rowCount} rows in ${Date.now() - exportOp.startTime}ms`,
					);
				} catch (err) {
					const errMsg = getErrorMessage(err);
					logger.error(`Error exporting data: ${errMsg}`);
					socketWrapper.emit("crawlError", {
						message: "Failed to export data",
						requestId,
					});
				} finally {
					activeExports.delete(socketWrapper.id);
				}
				break;
			}
		}
	};

	const handleClose = async (ws: { id: string }) => {
		const id = ws.id;

		// Clean up rate limiter data immediately on disconnect
		rateLimiter.removeSocket(id);

		// Clean up any active export for this socket
		activeExports.delete(id);

		const session = activeCrawls.get(id);
		if (session) {
			// interrupt() marks the session as 'interrupted' so it can be resumed later,
			// rather than 'completed' which stop() would set.
			session.interrupt();
			activeCrawls.delete(id);
		}
		logger.info(`Client disconnected: ${id}`);
	};

	return { handleMessage, handleClose, dispose };
}
