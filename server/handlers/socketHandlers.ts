import type { Database } from "bun:sqlite";
import dns from "node:dns";
import net from "node:net";
import { t } from "elysia";
import ipaddr from "ipaddr.js";
import type { Logger } from "../config/logging.js";
import { CrawlSession } from "../crawler/CrawlSession.js";
import type {
	ClampOptions,
	CrawledPage,
	CrawlerSocket,
	RawCrawlOptions,
	SanitizedCrawlOptions,
} from "../types.js";

const ALLOWED_CRAWL_METHODS = new Set(["links", "content", "media", "full"]);
const ALLOWED_IP_RANGES = new Set(["unicast", "global"]);
const ALLOWED_EXPORT_FORMATS = new Set(["json", "csv"]);

/** Regex to detect CSV injection characters at start of cell values */
const CSV_INJECTION_REGEX = /^[=+\-@|\t]/;

/**
 * Checks if an IP address is valid and within allowed unicast/global ranges.
 */
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

/** Validates that the hostname resolves to a public IP address to prevent SSRF. */
async function assertPublicHostname(hostname: string): Promise<void> {
	if (!hostname) {
		throw new Error("Target host is not allowed");
	}

	const normalizedHost =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;

	const lower = normalizedHost.toLowerCase();
	// Block explicit localhost to prevent internal service scanning
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
		// Resolve all IPs for the hostname to ensure none point to internal ranges
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

export const WebSocketMessageSchema = t.Object({
	type: t.String(),
	data: t.Optional(t.Any()),
});

type WebSocketMessage = typeof WebSocketMessageSchema.static;

/** Creates the WebSocket message handler logic for crawler interactions. */
export function createWebSocketHandlers(
	activeCrawls: Map<string, CrawlSession>,
	dbPromise: Promise<Database>,
	logger: Logger,
) {
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

		switch (message.type) {
			case "startAttack": {
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
					dbPromise,
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
				const url = message.data as string;
				try {
					if (!url) return;

					const db = await dbPromise;
					const pageRecord = db
						.query(`SELECT * FROM pages WHERE url = ?`)
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
							.query(`SELECT * FROM links WHERE source_id = ?`)
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
						});
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
				const format = (message.data as string) || "json";

				const sanitizedFormat =
					typeof format === "string" ? format.toLowerCase().trim() : "";

				if (!ALLOWED_EXPORT_FORMATS.has(sanitizedFormat)) {
					socketWrapper.emit("crawlError", {
						message: 'Invalid export format. Use "json" or "csv".',
					});
					return;
				}

				try {
					const db = await dbPromise;
					const rows = db
						.query(
							`SELECT id, url, domain, crawled_at, status_code,
                                       data_length, title, description FROM pages`,
						)
						.all() as Record<string, unknown>[];

					socketWrapper.emit("exportStart", { format: sanitizedFormat });

					const CHUNK_SIZE = 500;
					let chunk: string[] = [];
					let isFirstChunk = true;
					let rowCount = 0;

					if (sanitizedFormat === "json") {
						socketWrapper.emit("exportChunk", { data: "[" });
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
							socketWrapper.emit("exportChunk", { data: `${csvHeaders}\n` });
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

						if (chunk.length >= CHUNK_SIZE) {
							const data =
								sanitizedFormat === "json"
									? chunk.join("")
									: `${chunk.join("\n")}\n`;
							socketWrapper.emit("exportChunk", { data });
							chunk = [];
							isFirstChunk = false;
							await new Promise((resolve) => setImmediate(resolve));
						}
					}

					if (chunk.length > 0) {
						const data =
							sanitizedFormat === "json"
								? chunk.join("")
								: `${chunk.join("\n")}\n`;
						socketWrapper.emit("exportChunk", { data });
					}

					if (sanitizedFormat === "json") {
						socketWrapper.emit("exportChunk", { data: "]" });
					}

					socketWrapper.emit("exportComplete", { count: rowCount });
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					logger.error(`Error exporting data: ${message}`);
					socketWrapper.emit("crawlError", {
						message: "Failed to export data",
					});
				}
				break;
			}
		}
	};

	const handleClose = (ws: { id: string; data: { id: string } }) => {
		const id = ws.data.id || ws.id;
		const session = activeCrawls.get(id);
		if (session) {
			session.stop();
			activeCrawls.delete(id);
		}
		logger.info(`Client disconnected: ${id}`);
	};

	return { handleMessage, handleClose };
}
