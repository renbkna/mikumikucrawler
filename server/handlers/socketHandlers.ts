import type Database from "better-sqlite3";
import ipaddr from "ipaddr.js";
import dns from "node:dns";
import net from "node:net";
import type { Socket, Server as SocketIOServer } from "socket.io";
import type { Logger } from "winston";
import { CrawlSession } from "../crawler/CrawlSession.js";
import type {
	ClampOptions,
	RawCrawlOptions,
	SanitizedCrawlOptions,
} from "../types.js";

const ALLOWED_CRAWL_METHODS = new Set(["links", "content", "media", "full"]);
const ALLOWED_IP_RANGES = new Set(["unicast", "global"]);

function isInvalidIpAddress(address: string): boolean {
	let parsed: ipaddr.IPv4 | ipaddr.IPv6;
	try {
		parsed = ipaddr.parse(address);
	} catch {
		return true;
	}

	if (
		parsed.kind() === "ipv6" &&
		(parsed as ipaddr.IPv6).isIPv4MappedAddress()
	) {
		parsed = (parsed as ipaddr.IPv6).toIPv4Address();
	}

	const range = parsed.range();
	return !ALLOWED_IP_RANGES.has(range);
}

async function assertPublicHostname(hostname: string): Promise<void> {
	if (!hostname) {
		throw new Error("Target host is not allowed");
	}

	const normalizedHost =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;

	const lower = normalizedHost.toLowerCase();
	if (lower === "localhost") {
		throw new Error("Target host is not allowed");
	}

	const ipType = net.isIP(normalizedHost);
	if (ipType) {
		if (isInvalidIpAddress(normalizedHost)) {
			throw new Error("Target host is not allowed");
		}
		return;
	}

	let records: dns.LookupAddress[];
	try {
		records = await dns.promises.lookup(normalizedHost, {
			all: true,
			verbatim: false,
		});
	} catch {
		throw new Error("Unable to resolve target hostname");
	}

	if (!records?.length) {
		throw new Error("Unable to resolve target hostname");
	}

	const hasInvalidRecord = records.some(({ address }) =>
		isInvalidIpAddress(address),
	);
	if (hasInvalidRecord) {
		throw new Error("Target host is not allowed");
	}
}

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

	return {
		target: parsedUrl.toString(),
		crawlDepth,
		maxPages,
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

export function setupSocketHandlers(
	io: SocketIOServer,
	dbPromise: Promise<Database.Database>,
	logger: Logger,
): Map<string, CrawlSession> {
	const activeCrawls = new Map<string, CrawlSession>();

	io.on("connection", (socket: Socket) => {
		logger.info(`Client connected: ${socket.id}`);
		let crawlSession: CrawlSession | null = null;

		socket.on("startAttack", async (options: RawCrawlOptions) => {
			if (crawlSession) {
				await crawlSession.stop();
			}

			let validatedOptions: SanitizedCrawlOptions;
			try {
				validatedOptions = await sanitizeOptions(options);
			} catch (validationError) {
				const message =
					validationError instanceof Error
						? validationError.message
						: "Invalid options";
				logger.warn(`Invalid crawl options from ${socket.id}: ${message}`);
				socket.emit("crawlError", { message });
				return;
			}

			logger.info(
				`Starting new crawl session for ${socket.id} with target: ${validatedOptions.target}`,
			);

			crawlSession = new CrawlSession(
				socket,
				validatedOptions,
				dbPromise,
				logger,
			);
			activeCrawls.set(socket.id, crawlSession);
			crawlSession.start();
		});

		socket.on("stopAttack", async () => {
			logger.info(`Stopping crawl session for ${socket.id}`);
			if (crawlSession) {
				await crawlSession.stop();
				activeCrawls.delete(socket.id);
				crawlSession = null;
			}
		});

		socket.on("getPageDetails", async (url: string) => {
			try {
				if (!url) return;

				const db = await dbPromise;
				const page = db.prepare(`SELECT * FROM pages WHERE url = ?`).get(url) as
					| { id: number }
					| undefined;

				if (page) {
					const links = db
						.prepare(`SELECT * FROM links WHERE source_id = ?`)
						.all(page.id);

					socket.emit("pageDetails", { ...page, links });
				} else {
					socket.emit("pageDetails", null);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				logger.error(`Error getting page details: ${message}`);
				socket.emit("crawlError", { message: "Failed to get page details" });
			}
		});

		socket.on("exportData", async (format: string) => {
			const ALLOWED_EXPORT_FORMATS = new Set(["json", "csv"]);

			// Validate and sanitize format
			const sanitizedFormat =
				typeof format === "string" ? format.toLowerCase().trim() : "";

			if (!ALLOWED_EXPORT_FORMATS.has(sanitizedFormat)) {
				socket.emit("crawlError", {
					message: 'Invalid export format. Use "json" or "csv".',
				});
				return;
			}

			try {
				const db = await dbPromise;
				const stmt =
					db.prepare(`SELECT id, url, domain, crawled_at, status_code,
                                   data_length, title, description FROM pages`);

				socket.emit("exportStart", { format: sanitizedFormat });

				const CHUNK_SIZE = 500;
				let chunk: string[] = [];
				let isFirstChunk = true;
				let rowCount = 0;

				const iterator = stmt.iterate();

				if (sanitizedFormat === "json") {
					socket.emit("exportChunk", { data: "[" }); // Start JSON array
				}

				const escapeCsvCell = (value: unknown): string => {
					if (value === null || value === undefined) return '""';
					// Handle objects/arrays by stringifying them, use explicit type checks
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
					// Prevent formula injection: =, +, -, @, |, and tab can trigger exploits
					if (/^[=+\-@|\t]/.test(stringValue)) {
						stringValue = `'${stringValue}`;
					}
					stringValue = stringValue.replaceAll('"', '""');
					return `"${stringValue}"`;
				};

				for (const row of iterator) {
					rowCount++;
					const rowObj = row as Record<string, unknown>;

					if (sanitizedFormat === "csv" && isFirstChunk && rowCount === 1) {
						const csvHeaders = Object.keys(rowObj).join(",");
						socket.emit("exportChunk", { data: `${csvHeaders}\n` });
					}

					if (sanitizedFormat === "json") {
						// For JSON, we need comma separation between objects, but not before the first one
						const prefix: string = !isFirstChunk || chunk.length > 0 ? "," : "";
						chunk.push(prefix + JSON.stringify(rowObj, null, 2));
					} else {
						// CSV
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
						socket.emit("exportChunk", { data });
						chunk = [];
						isFirstChunk = false;

						// Tiny delay to allow event loop to breathe if needed
						await new Promise((resolve) => setImmediate(resolve));
					}
				}

				// Flush remaining chunk
				if (chunk.length > 0) {
					const data =
						sanitizedFormat === "json"
							? chunk.join("")
							: `${chunk.join("\n")}\n`;
					socket.emit("exportChunk", { data });
				}

				if (sanitizedFormat === "json") {
					socket.emit("exportChunk", { data: "]" }); // End JSON array
				}

				socket.emit("exportComplete", { count: rowCount });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				logger.error(`Error exporting data: ${message}`);
				socket.emit("crawlError", { message: "Failed to export data" });
			}
		});

		socket.on("disconnect", () => {
			if (crawlSession) {
				crawlSession.stop();
				activeCrawls.delete(socket.id);
			}
			logger.info(`Client disconnected: ${socket.id}`);
		});
	});

	return activeCrawls;
}
