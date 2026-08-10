import { Music } from "lucide-react";
import { memo } from "react";
import type { RunPhase } from "../hooks/crawlControllerState";

interface ProgressBarProps {
	progress: number;
	runPhase: RunPhase;
}

const outcomeMessageByPhase: Partial<Record<RunPhase, string>> = {
	completed: "All done! Sugoi~!",
	failed: "Crawl failed before completion",
	stopped: "Crawl was stopped",
	paused: "Crawl is paused",
	interrupted: "Crawl was interrupted",
};

export const ProgressBar = memo(function ProgressBar({ progress, runPhase }: ProgressBarProps) {
	const isWorking =
		runPhase === "starting" ||
		runPhase === "running" ||
		runPhase === "pausing" ||
		runPhase === "stopping";
	const outcomeMessage = outcomeMessageByPhase[runPhase];
	return (
		<div className="relative">
			<div className="flex items-center justify-between mb-4">
				<div className="flex items-center gap-2">
					<span className="text-sm font-bold uppercase tracking-wider text-miku-teal-dark flex items-center gap-2">
						<Music
							className={`w-5 h-5 ${isWorking && progress > 0 && progress < 100 ? "animate-bounce" : ""} text-miku-teal`}
						/>
						Crawl Progress
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-lg font-semibold text-miku-accent/80">{progress.toFixed(0)}%</span>
				</div>
			</div>

			<progress
				value={progress}
				max={100}
				aria-label="Crawl progress"
				className="w-full h-5 accent-miku-teal"
			/>

			<div className="mt-3 text-center h-5">
				{isWorking && progress > 0 && progress < 100 && (
					<span className="text-xs font-medium text-miku-pink animate-pulse flex items-center justify-center gap-1">
						Miku is working hard! Ganbare~!
					</span>
				)}
				{outcomeMessage && (
					<span
						className={`text-xs font-medium flex items-center justify-center gap-1 ${runPhase === "completed" ? "text-miku-teal animate-bounce" : runPhase === "paused" || runPhase === "interrupted" ? "text-miku-accent" : "text-rose-500"}`}
					>
						{outcomeMessage}
					</span>
				)}
			</div>
		</div>
	);
});
