import { Music } from "lucide-react";
import { memo } from "react";
import { NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface ProgressBarProps {
	progress: number;
}

export const ProgressBar = memo(function ProgressBar({ progress }: ProgressBarProps) {
	return (
		<div className="relative">
			<div className="flex items-center justify-between mb-4">
				<div className="flex items-center gap-2">
					<span className="text-sm font-bold uppercase tracking-wider text-miku-teal-dark flex items-center gap-2">
						<Music
							className={`w-5 h-5 ${progress > 0 && progress < 100 ? "animate-bounce" : ""} text-miku-teal`}
						/>
						Crawl Progress <NoteIcon className="hidden" size={14} />
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-lg font-semibold text-miku-accent/80">{progress.toFixed(0)}%</span>
				</div>
			</div>

			<div className="relative h-5 rounded-full bg-miku-accent/5 overflow-hidden border border-miku-accent/15">
				<div className="hidden" />

				<div
					className="relative h-full transition-all duration-700 ease-out energy-bar rounded-full"
					style={{ width: `${progress}%` }}
				>
					<div className="absolute inset-0 bg-white/10" />

					{progress > 0 && progress < 100 && (
						<div className="absolute right-1 top-1/2 -translate-y-1/2">
							<SparkleIcon className="text-white animate-ping" size={12} />
						</div>
					)}
				</div>
			</div>

			<div className="mt-3 text-center h-5">
				{progress > 0 && progress < 100 && (
					<span className="text-xs font-medium text-miku-pink animate-pulse flex items-center justify-center gap-1">
						<NoteIcon className="hidden" size={12} />
						Miku is working hard! Ganbare~!
						<NoteIcon className="hidden" size={12} />
					</span>
				)}
				{progress === 100 && (
					<span className="text-xs font-medium text-miku-teal animate-bounce flex items-center justify-center gap-1">
						<SparkleIcon className="hidden" size={12} />
						All done! Sugoi~!
						<SparkleIcon className="hidden" size={12} />
					</span>
				)}
			</div>
		</div>
	);
});

ProgressBar.displayName = "ProgressBar";
