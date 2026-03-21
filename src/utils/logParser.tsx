import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	Info,
	Terminal,
} from "lucide-react";

export interface ParsedLog {
	raw: string;
	level: "info" | "error" | "warn" | "debug" | "success" | "unknown";
	message: string;
	timestamp?: string;
	metadata?: Record<string, unknown>;
}

const LOG_LEVELS = {
	info: {
		icon: Info,
		color: "text-miku-teal",
		bgColor: "bg-miku-teal/10",
		borderColor: "border-miku-teal/30",
		label: "INFO",
	},
	error: {
		icon: AlertCircle,
		color: "text-rose-500",
		bgColor: "bg-rose-500/10",
		borderColor: "border-rose-500/30",
		label: "ERROR",
	},
	warn: {
		icon: AlertTriangle,
		color: "text-amber-500",
		bgColor: "bg-amber-500/10",
		borderColor: "border-amber-500/30",
		label: "WARN",
	},
	debug: {
		icon: Terminal,
		color: "text-slate-500",
		bgColor: "bg-slate-500/10",
		borderColor: "border-slate-500/30",
		label: "DEBUG",
	},
	success: {
		icon: CheckCircle2,
		color: "text-emerald-500",
		bgColor: "bg-emerald-500/10",
		borderColor: "border-emerald-500/30",
		label: "SUCCESS",
	},
	unknown: {
		icon: Terminal,
		color: "text-miku-text/50",
		bgColor: "bg-miku-text/5",
		borderColor: "border-miku-text/10",
		label: "LOG",
	},
};

export function parseLog(log: string): ParsedLog {
	try {
		const parsed = JSON.parse(log);
		return {
			raw: log,
			level: parsed.level || "unknown",
			message: parsed.message || log,
			timestamp: parsed.timestamp,
			metadata: parsed,
		};
	} catch {
		// Try to detect level from plain text
		let level: ParsedLog["level"] = "unknown";
		const lowerLog = log.toLowerCase();

		if (lowerLog.includes("error") || lowerLog.includes("failed")) {
			level = "error";
		} else if (lowerLog.includes("warn")) {
			level = "warn";
		} else if (lowerLog.includes("success") || lowerLog.includes("completed")) {
			level = "success";
		} else if (
			lowerLog.includes("info") ||
			lowerLog.includes("starting") ||
			lowerLog.includes("fetching")
		) {
			level = "info";
		}

		return {
			raw: log,
			level,
			message: log,
		};
	}
}

export function getLogLevelConfig(level: ParsedLog["level"]) {
	return LOG_LEVELS[level] || LOG_LEVELS.unknown;
}

export function formatTimestamp(timestamp?: string): string {
	if (!timestamp) return "";
	try {
		const date = new Date(timestamp);
		return date.toLocaleTimeString("en-US", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
	} catch {
		return "";
	}
}

export function highlightUrls(text: string): React.ReactNode {
	const urlRegex = /(https?:\/\/[^\s]+)/g;
	const parts = text.split(urlRegex);

	return parts.map((part, index) => {
		const key = `${part.slice(0, 20)}-${index}`;
		if (part.match(urlRegex)) {
			return (
				<span
					key={key}
					className="text-miku-pink font-medium underline decoration-dotted hover:decoration-solid cursor-pointer"
					title={part}
				>
					{part.length > 50 ? `${part.substring(0, 50)}...` : part}
				</span>
			);
		}
		return <span key={key}>{part}</span>;
	});
}

export function getLogCategory(message: string): string {
	const lowerMsg = message.toLowerCase();
	if (lowerMsg.includes("fetch")) return "🌐 Network";
	if (lowerMsg.includes("crawl") || lowerMsg.includes("session"))
		return "🕷️ Crawler";
	if (
		lowerMsg.includes("puppeteer") ||
		lowerMsg.includes("playwright") ||
		lowerMsg.includes("chrome")
	)
		return "🎭 Browser";
	if (lowerMsg.includes("client") || lowerMsg.includes("socket"))
		return "🔌 Connection";
	if (lowerMsg.includes("retry")) return "🔄 Retry";
	if (lowerMsg.includes("page")) return "📄 Page";
	return "📝 System";
}
