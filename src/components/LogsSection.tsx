import { Terminal, Trash2 } from "lucide-react";
import { memo, type RefObject } from "react";
import { Virtuoso } from "react-virtuoso";
import { NoteIcon } from "./KawaiiIcons";

const LogItem = memo(function LogItem({
	log,
	stableIndex,
}: {
	log: string;
	stableIndex: number;
}) {
	return (
		<div className="text-sm font-medium text-miku-text/80 py-3 border-b border-miku-pink/10 last:border-0 flex gap-4 group hover:bg-miku-teal/5 rounded-xl px-3 transition-all ml-6">
			<span className="text-miku-teal/40 font-mono text-xs mt-0.5 select-none font-bold">
				{String(stableIndex).padStart(2, "0")}
			</span>
			<span className="leading-relaxed break-all">{log}</span>
		</div>
	);
});

interface LogsSectionProps {
	logs: string[];
	setLogs: (logs: string[]) => void;
	logContainerRef: RefObject<HTMLDivElement>;
}

export const LogsSection = memo(function LogsSection({
	logs,
	setLogs,
	logContainerRef,
}: LogsSectionProps) {
	return (
		<div className="h-full flex flex-col relative">
			{/* Cute notebook binding effect */}
			<div className="absolute left-6 top-0 bottom-0 w-px border-r-2 border-dashed border-miku-teal/20 z-0"></div>

			<div className="flex-1 rounded-[20px] relative z-10 flex flex-col h-full overflow-hidden">
				{/* Header */}
				<div className="flex items-center justify-between mb-2 pl-8 pt-6 pr-6 shrink-0">
					<div className="flex items-center gap-3">
						<div className="p-2 rounded-xl bg-gradient-to-br from-miku-teal/20 to-miku-teal/10 text-miku-teal border border-miku-teal/20">
							<Terminal className="w-4 h-4" />
						</div>
						<span className="cute-badge flex items-center gap-1">
							<NoteIcon className="text-miku-teal" size={10} />
							{logs.length} entries
						</span>
					</div>

					<button
						type="button"
						onClick={() => setLogs([])}
						className="p-2 rounded-full hover:bg-rose-50 text-miku-text/30 hover:text-rose-400 transition-colors"
						title="Clear Logs"
					>
						<Trash2 className="w-4 h-4" />
					</button>
				</div>

				{/* Logs Container */}
				<div className="flex-1 pl-2" ref={logContainerRef}>
					{logs.length > 0 ? (
						<Virtuoso
							style={{ height: "100%" }}
							data={logs}
							itemContent={(index, log) => {
								const stableIndex = logs.length - index;
								// Index is stable for prepend-only lists
								return (
									<LogItem
										key={`log-${index}`}
										log={log}
										stableIndex={stableIndex}
									/>
								);
							}}
						/>
					) : (
						<div className="h-full flex flex-col items-center justify-center text-miku-text/40 italic">
							<NoteIcon
								className="text-miku-teal/30 mb-4 animate-bounce-slow"
								size={48}
							/>
							<p className="font-medium">
								Waiting for Miku to start writing...
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});

LogsSection.displayName = "LogsSection";
