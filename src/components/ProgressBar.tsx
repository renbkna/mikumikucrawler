import { Music } from "lucide-react";
import { memo } from "react";
import { NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface ProgressBarProps {
	progress: number;
}

/** Visual indicator of the crawl completion state with themed animations. */
export const ProgressBar = memo(function ProgressBar({
	progress,
}: ProgressBarProps) {
	return (
		<div className="mb-8 relative">
			<div className="flex items-center justify-between mb-3 px-2">
				<div className="flex items-center gap-2">
					<span className="text-lg font-bold text-miku-text flex items-center gap-2">
						<Music
							className={`w-5 h-5 ${progress > 0 && progress < 100 ? "animate-bounce" : ""} text-miku-teal`}
						/>
						Crawl Progress <NoteIcon className="text-miku-teal" size={14} />
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-2xl font-black text-miku-teal">
						{progress.toFixed(0)}%
					</span>
				</div>
			</div>

			<div className="relative h-6 rounded-full bg-white/50 overflow-hidden shadow-inner border-2 border-miku-pink/20">
				<div
					className="absolute inset-0 opacity-20"
					style={{
						backgroundImage: "radial-gradient(#39C5BB 1px, transparent 1px)",
						backgroundSize: "8px 8px",
					}}
				/>

				<div
					className="relative h-full transition-all duration-700 ease-out energy-bar rounded-full"
					style={{ width: `${progress}%` }}
				>
					<div className="absolute inset-0 bg-gradient-to-b from-white/40 to-transparent" />

					{progress > 0 && progress < 100 && (
						<div className="absolute right-1 top-1/2 -translate-y-1/2">
							<SparkleIcon className="text-white animate-ping" size={12} />
						</div>
					)}
				</div>
			</div>

			<div className="mt-3 text-center h-6">
				{progress > 0 && progress < 100 && (
					<span className="text-sm font-bold text-miku-pink animate-pulse flex items-center justify-center gap-1">
						<NoteIcon className="text-miku-pink" size={12} />
						Miku is working hard! Ganbare~!
						<NoteIcon className="text-miku-teal" size={12} />
					</span>
				)}
				{progress === 100 && (
					<span className="text-sm font-bold text-miku-teal animate-bounce flex items-center justify-center gap-1">
						<SparkleIcon className="text-miku-teal" size={12} />
						All done! Sugoi~!
						<SparkleIcon className="text-miku-pink" size={12} />
					</span>
				)}
			</div>
		</div>
	);
});

ProgressBar.displayName = "ProgressBar";
