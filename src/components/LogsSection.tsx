import { Copy, Filter, Terminal, Trash2, X } from "lucide-react";
import { memo, type RefObject, useCallback, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import {
	formatTimestamp,
	getLogCategory,
	getLogLevelConfig,
	highlightUrls,
	type ParsedLog,
	parseLog,
} from "../utils/logParser";
import { NoteIcon } from "./KawaiiIcons";

interface LogItemProps {
	log: ParsedLog;
	stableIndex: number;
	onCopy: (text: string) => void;
}

const LogItem = memo(function LogItem({
	log,
	stableIndex,
	onCopy,
}: LogItemProps) {
	const config = getLogLevelConfig(log.level);
	const Icon = config.icon;
	const category = getLogCategory(log.message);
	const timestamp = formatTimestamp(log.timestamp);

	const handleCopy = useCallback(() => {
		onCopy(log.raw);
	}, [log.raw, onCopy]);

	return (
		<div
			className={`group relative py-3 px-4 border-b border-miku-pink/5 hover:bg-gradient-to-r ${config.bgColor} hover:border-transparent transition-all duration-300 animate-in slide-in-from-left-2 fade-in duration-500`}
		>
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

						{timestamp && (
							<span className="text-[10px] text-miku-text/40 font-mono">
								{timestamp}
							</span>
						)}

						<span className="text-[10px] text-miku-text/30">{category}</span>

						{/* Copy button - appears on hover */}
						<button
							type="button"
							onClick={handleCopy}
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
});

interface LogsSectionProps {
	logs: string[];
	clearLogs: () => void;
	logContainerRef: RefObject<HTMLDivElement>;
}

export const LogsSection = memo(function LogsSection({
	logs,
	clearLogs,
	logContainerRef,
}: Readonly<LogsSectionProps>) {
	const [filterLevel, setFilterLevel] = useState<ParsedLog["level"] | "all">(
		"all",
	);
	const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

	const parsedLogs = useMemo(() => {
		return logs.map((log) => parseLog(log));
	}, [logs]);

	const filteredLogs = useMemo(() => {
		if (filterLevel === "all") return parsedLogs;
		return parsedLogs.filter((log) => log.level === filterLevel);
	}, [parsedLogs, filterLevel]);

	const handleCopy = useCallback((text: string) => {
		navigator.clipboard.writeText(text);
		const index = Date.now();
		setCopiedIndex(index);
		setTimeout(
			() => setCopiedIndex((prev) => (prev === index ? null : prev)),
			2000,
		);
	}, []);

	const clearFilter = useCallback(() => {
		setFilterLevel("all");
	}, []);

	const renderLogItem = useCallback(
		(index: number, log: ParsedLog) => {
			const stableIndex = filteredLogs.length - index;
			return (
				<LogItem log={log} stableIndex={stableIndex} onCopy={handleCopy} />
			);
		},
		[filteredLogs.length, handleCopy],
	);

	const levelOptions: {
		value: ParsedLog["level"] | "all";
		label: string;
		count: number;
	}[] = [
		{ value: "all", label: "All", count: logs.length },
		{
			value: "info",
			label: "Info",
			count: parsedLogs.filter((l) => l.level === "info").length,
		},
		{
			value: "error",
			label: "Error",
			count: parsedLogs.filter((l) => l.level === "error").length,
		},
		{
			value: "warn",
			label: "Warn",
			count: parsedLogs.filter((l) => l.level === "warn").length,
		},
		{
			value: "success",
			label: "Success",
			count: parsedLogs.filter((l) => l.level === "success").length,
		},
	];

	return (
		<div className="h-full flex flex-col relative">
			{/* Decorative line */}
			<div className="absolute left-4 top-0 bottom-0 w-px bg-gradient-to-b from-miku-teal/20 via-miku-pink/20 to-transparent z-0" />

			<div className="flex-1 rounded-[20px] relative z-10 flex flex-col h-full overflow-hidden bg-white/5 backdrop-blur-sm border border-miku-teal/10">
				{/* Header */}
				<div className="flex items-center justify-between p-4 border-b border-miku-teal/10 shrink-0 bg-gradient-to-r from-miku-teal/5 to-transparent">
					<div className="flex items-center gap-3">
						<div className="p-2 rounded-xl bg-gradient-to-br from-miku-teal/20 to-miku-teal/10 text-miku-teal border border-miku-teal/20">
							<Terminal className="w-4 h-4" />
						</div>
						<div className="flex flex-col">
							<span className="text-sm font-bold text-miku-text flex items-center gap-2">
								System Logs
								<span className="cute-badge flex items-center gap-1 text-[10px]">
									<NoteIcon className="text-miku-teal" size={10} />
									{logs.length} total
								</span>
							</span>
							<span className="text-[10px] text-miku-text/40">
								{filteredLogs.length} shown
							</span>
						</div>
					</div>

					<div className="flex items-center gap-2">
						{/* Level filter */}
						<div className="flex items-center gap-1 bg-miku-text/5 rounded-lg p-1 border border-miku-text/10">
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
									{option.count > 0 && (
										<span className="ml-1 opacity-60">({option.count})</span>
									)}
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
					<div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-miku-teal text-white px-3 py-1.5 rounded-full text-xs font-medium shadow-lg animate-in fade-in slide-in-from-top-2">
						Copied to clipboard!
					</div>
				)}

				{/* Filter indicator */}
				{filterLevel !== "all" && (
					<div className="px-4 py-2 bg-miku-teal/5 border-b border-miku-teal/10 flex items-center justify-between">
						<span className="text-xs text-miku-text/60">
							Filtering by:{" "}
							<span className="font-medium text-miku-teal">{filterLevel}</span>
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
				<div className="flex-1 overflow-hidden" ref={logContainerRef}>
					{filteredLogs.length > 0 ? (
						<Virtuoso
							style={{ height: "100%" }}
							data={filteredLogs}
							itemContent={renderLogItem}
							overscan={5}
						/>
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
							<NoteIcon
								className="text-miku-teal/30 mb-4 animate-bounce-slow"
								size={48}
							/>
							<p className="font-medium">
								Waiting for Miku to start writing...
							</p>
							<p className="text-xs mt-1 opacity-60">
								Logs will appear here when crawling begins
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});

LogsSection.displayName = "LogsSection";
