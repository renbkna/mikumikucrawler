import type { Transform } from "node:stream";
import type { PrettyOptions } from "pino-pretty";
import pinoPretty from "pino-pretty";

/**
 * Custom Pino pretty printer with beautiful visual formatting.
 * Includes icons, colors, and better layout for development.
 */

// Map numeric levels to names and icons
const levelMap: Record<number, { name: string; icon: string; color: string }> =
	{
		10: { name: "TRACE", icon: "🔍", color: "\x1b[90m" }, // Gray
		20: { name: "DEBUG", icon: "🐛", color: "\x1b[36m" }, // Cyan
		30: { name: "INFO", icon: "✨", color: "\x1b[34m" }, // Blue
		40: { name: "WARN", icon: "⚠️ ", color: "\x1b[33m" }, // Yellow
		50: { name: "ERROR", icon: "❌", color: "\x1b[31m" }, // Red
		60: { name: "FATAL", icon: "💀", color: "\x1b[35m" }, // Magenta
	};

/**
 * Format bytes to human readable string.
 */
function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

function toLogString(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	if (value === null || value === undefined) {
		return "";
	}

	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}

/**
 * Creates a beautiful custom pretty printer for Pino logs.
 */
export function createPrettyPrinter(): Transform {
	const options: PrettyOptions = {
		colorize: true,
		translateTime: "SYS:HH:MM:ss",
		ignore: "pid,hostname,service,level",
		messageFormat: (log: Record<string, unknown>) => {
			const levelNum = Number(log.level) || 30;
			const levelInfo = levelMap[levelNum] || {
				name: "LOG",
				icon: "📝",
				color: "white",
			};
			const msg = toLogString(log.msg);

			// Format additional context if present
			const context: string[] = [];
			if (log.url) context.push(`🔗 ${toLogString(log.url)}`);
			if (log.domain) context.push(`🌐 ${toLogString(log.domain)}`);
			if (typeof log.duration === "number") {
				context.push(`⏱️  ${log.duration}ms`);
			}
			if (typeof log.count === "number") {
				context.push(`📊 ${log.count}`);
			}
			if (log.size) context.push(`📦 ${formatBytes(Number(log.size))}`);

			const contextStr = context.length > 0 ? ` | ${context.join(" | ")}` : "";

			// Return icon + message + context
			return `${levelInfo.icon} ${msg}${contextStr}`;
		},
	};

	return pinoPretty(options);
}

/**
 * Creates a startup banner for the server.
 */
export function createStartupBanner(config: {
	port: number;
	frontendUrl: string;
	env: string;
}): string {
	const lines = [
		"",
		"╔══════════════════════════════════════════════════════════╗",
		"║                🌸 Miku Crawler Server 🌸                 ║",
		"║                HTTP + SSE Web Crawler                    ║",
		"╚══════════════════════════════════════════════════════════╝",
		"",
		`  🚀 Server:     http://localhost:${config.port}`,
		`  📚 OpenAPI:    http://localhost:${config.port}/openapi`,
		`  🎨 Frontend:   ${config.frontendUrl}`,
		`  🌍 Environment: ${config.env}`,
		"",
		"  ✨ Features:",
		"     • HTTP control + SSE telemetry",
		"     • Rule-based sentiment analysis",
		"     • Native robots.txt parsing",
		"     • Eligible response compression (gzip/br)",
		"     • Concurrent crawl workers",
		"",
		"═══════════════════════════════════════════════════════════",
		"",
	];

	return lines.join("\n");
}
