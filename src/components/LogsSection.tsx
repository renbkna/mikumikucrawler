import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	Copy,
	Filter,
	Info,
	Music2,
	Trash2,
	X,
} from "lucide-react";
import { memo, type ReactNode, useMemo, useState } from "react";
import type { ControllerLog } from "../hooks/crawlControllerState";

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
	success: {
		icon: CheckCircle2,
		color: "text-emerald-500",
		bgColor: "bg-emerald-500/10",
		borderColor: "border-emerald-500/30",
		label: "SUCCESS",
	},
} as const;

function highlightUrls(text: string): ReactNode {
	const parts: ReactNode[] = [];
	let offset = 0;
	for (const match of text.matchAll(/https?:\/\/[^\s]+/g)) {
		if (match.index > offset) {
			parts.push(<span key={`text-${offset}`}>{text.slice(offset, match.index)}</span>);
		}
		const url = match[0];
		parts.push(
			<span
				key={`url-${match.index}`}
				className="text-miku-pink font-medium underline decoration-dotted hover:decoration-solid cursor-pointer"
				title={url}
			>
				{url.length > 50 ? `${url.substring(0, 50)}...` : url}
			</span>,
		);
		offset = match.index + url.length;
	}
	if (offset < text.length) parts.push(<span key={`text-${offset}`}>{text.slice(offset)}</span>);
	return parts.length > 0 ? parts : text;
}

function getLogCategory(message: string): string {
	const lowerMessage = message.toLowerCase();
	if (lowerMessage.includes("fetch")) return "🌐 Network";
	if (lowerMessage.includes("crawl") || lowerMessage.includes("session")) return "🕷️ Crawler";
	if (lowerMessage.includes("playwright") || lowerMessage.includes("chrome")) return "🎭 Browser";
	if (lowerMessage.includes("client") || lowerMessage.includes("socket")) return "🔌 Connection";
	if (lowerMessage.includes("retry")) return "🔄 Retry";
	if (lowerMessage.includes("page")) return "📄 Page";
	return "📝 System";
}

interface LogItemProps {
	log: ControllerLog;
	stableIndex: number;
	onCopy: (text: string) => void;
}

function LogItem({ log, stableIndex, onCopy }: LogItemProps) {
	const config = LOG_LEVELS[log.level];
	const Icon = config.icon;
	const category = getLogCategory(log.message);

	return (
		<div className="group relative py-3 px-3 border-b border-miku-border/60 hover:bg-white/55 transition-colors duration-200">
			<div className="flex items-start gap-3">
				{/* Index number */}
				<span className="text-miku-teal/30 font-mono text-xs mt-1 select-none font-bold min-w-[1.5rem]">
					{String(stableIndex).padStart(2, "0")}
				</span>

				{/* Level icon */}
				<div
					className={`p-1.5 rounded-lg ${config.bgColor} ${config.borderColor} border shrink-0 mt-0.5`}
				>
					<Icon className={`w-3.5 h-3.5 ${config.color}`} />
				</div>

				{/* Content */}
				<div className="flex-1 min-w-0">
					{/* Header row */}
					<div className="flex items-center gap-2 mb-1.5 flex-wrap">
						<span
							className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${config.bgColor} ${config.color} border ${config.borderColor}`}
						>
							{config.label}
						</span>

						<span className="text-[10px] text-miku-text/30">{category}</span>

						{/* Copy button - appears on hover */}
						<button
							type="button"
							onClick={() => onCopy(log.message)}
							className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-miku-text/10 text-miku-text/40 hover:text-miku-text/60"
							title="Copy log"
						>
							<Copy className="w-3 h-3" />
						</button>
					</div>

					{/* Message */}
					<p className="text-sm text-miku-text/80 leading-relaxed break-all">
						{highlightUrls(log.message)}
					</p>
				</div>
			</div>
		</div>
	);
}

interface LogsSectionProps {
	logs: readonly ControllerLog[];
	clearLogs: () => void;
}

export const LogsSection = memo(function LogsSection({
	logs,
	clearLogs,
}: Readonly<LogsSectionProps>) {
	const [filterLevel, setFilterLevel] = useState<ControllerLog["level"] | "all">("all");
	const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

	const filteredLogs = useMemo(() => {
		if (filterLevel === "all") return logs;
		return logs.filter((log) => log.level === filterLevel);
	}, [logs, filterLevel]);

	const handleCopy = (text: string) => {
		void navigator.clipboard
			.writeText(text)
			.then(() => {
				const index = Date.now();
				setCopiedIndex(index);
				setTimeout(() => setCopiedIndex((prev) => (prev === index ? null : prev)), 2000);
			})
			.catch(() => undefined);
	};

	const clearFilter = () => {
		setFilterLevel("all");
	};

	const levelOptions: {
		value: ControllerLog["level"] | "all";
		label: string;
		count: number;
	}[] = [
		{ value: "all", label: "All", count: logs.length },
		{
			value: "info",
			label: "Info",
			count: logs.filter((log) => log.level === "info").length,
		},
		{
			value: "error",
			label: "Error",
			count: logs.filter((log) => log.level === "error").length,
		},
		{
			value: "warn",
			label: "Warn",
			count: logs.filter((log) => log.level === "warn").length,
		},
		{
			value: "success",
			label: "Success",
			count: logs.filter((log) => log.level === "success").length,
		},
	];

	return (
		<div className="h-full flex flex-col relative">
			<div className="flex-1 relative z-10 flex flex-col h-full overflow-hidden">
				{/* Header */}
				<div className="flex items-center justify-end pb-3 border-b border-miku-teal/10 shrink-0">
					<div className="flex items-center gap-2">
						{/* Level filter */}
						<div className="flex items-center gap-1 bg-white/55 rounded-lg p-1 border border-miku-border">
							<Filter className="w-3 h-3 text-miku-text/40 ml-1" />
							{levelOptions.map((option) => (
								<button
									type="button"
									key={option.value}
									onClick={() => setFilterLevel(option.value)}
									className={`px-2 py-1 rounded-md text-[10px] font-medium transition-all ${
										filterLevel === option.value
											? "bg-miku-teal text-white shadow-sm"
											: "text-miku-text/60 hover:text-miku-text hover:bg-miku-text/10"
									}`}
								>
									{option.label}
									{option.count > 0 && <span className="ml-1 opacity-60">({option.count})</span>}
								</button>
							))}
						</div>

						{/* Clear logs button */}
						<button
							type="button"
							onClick={clearLogs}
							className="p-2 rounded-lg hover:bg-rose-50 text-miku-text/30 hover:text-rose-400 transition-colors"
							title="Clear Logs"
						>
							<Trash2 className="w-4 h-4" />
						</button>
					</div>
				</div>

				{/* Copied notification */}
				{copiedIndex !== null && (
					<div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-miku-teal text-white px-3 py-1.5 rounded-lg text-xs font-medium shadow-sm">
						Copied to clipboard!
					</div>
				)}

				{/* Filter indicator */}
				{filterLevel !== "all" && (
					<div className="px-4 py-2 bg-miku-teal/5 border-b border-miku-teal/10 flex items-center justify-between">
						<span className="text-xs text-miku-text/60">
							Filtering by: <span className="font-medium text-miku-teal">{filterLevel}</span>
						</span>
						<button
							type="button"
							onClick={clearFilter}
							className="text-xs text-miku-text/40 hover:text-miku-text flex items-center gap-1"
						>
							<X className="w-3 h-3" />
							Clear filter
						</button>
					</div>
				)}

				{/* Logs list */}
				<div className="flex-1 overflow-y-auto custom-scrollbar">
					{filteredLogs.length > 0 ? (
						filteredLogs.map((log, index) => (
							<LogItem
								key={log.id}
								log={log}
								stableIndex={filteredLogs.length - index}
								onCopy={handleCopy}
							/>
						))
					) : logs.length > 0 ? (
						<div className="h-full flex flex-col items-center justify-center text-miku-text/40">
							<Filter className="w-12 h-12 mb-4 text-miku-text/20" />
							<p className="text-sm font-medium">No logs match the filter</p>
							<button
								type="button"
								onClick={clearFilter}
								className="mt-2 text-xs text-miku-teal hover:underline"
							>
								Clear filter
							</button>
						</div>
					) : (
						<div className="h-full flex flex-col items-center justify-center text-miku-text/40">
							<Music2 className="text-miku-teal/35 mb-3" size={34} />
							<p className="font-medium">Waiting for Miku to start writing...</p>
							<p className="text-xs mt-1 opacity-60">Logs will appear here when crawling begins</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});
