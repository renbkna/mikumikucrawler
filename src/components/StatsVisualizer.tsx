import { PieChart } from "lucide-react";
import type { Stats } from "../types";

interface StatsVisualizerProps {
	stats: Stats;
}

/** Renders success rate, speed, and elapsed time using themed progress indicators. */
export function StatsVisualizer({ stats }: Readonly<StatsVisualizerProps>) {
	return (
		<div className="glass-panel p-6 mt-4">
			<h3 className="flex items-center mb-4 font-bold text-miku-teal">
				<PieChart className="w-5 h-5 mr-2" />♪ Crawl Statistics ♪
			</h3>

			<div className="space-y-4">
				{stats.successRate && (
					<div>
						<div className="flex justify-between mb-2 text-sm text-miku-text font-medium">
							<span>Success Rate ✧</span>
							<span className="text-emerald-500 font-bold">
								{stats.successRate}
							</span>
						</div>
						<div className="h-3 bg-miku-pink/10 rounded-full overflow-hidden border-2 border-miku-pink/20">
							<div
								className="h-full bg-gradient-to-r from-emerald-400 to-emerald-300 rounded-full transition-all duration-500"
								style={{ width: stats.successRate }}
							/>
						</div>
					</div>
				)}

				{stats.pagesPerSecond && (
					<div>
						<div className="flex justify-between mb-2 text-sm text-miku-text font-medium">
							<span>Speed ♥</span>
							<span className="text-miku-teal font-bold">
								{stats.pagesPerSecond} pages/sec
							</span>
						</div>
						<div className="h-3 bg-miku-teal/10 rounded-full overflow-hidden border-2 border-miku-teal/20">
							<div
								className="h-full bg-gradient-to-r from-miku-teal to-teal-300 rounded-full transition-all duration-500"
								style={{
									// Scale: 5 pages/sec = 100% width (Arbitrary visual cap)
									width: `${Math.min(Number(stats.pagesPerSecond) * 20, 100)}%`,
								}}
							/>
						</div>
					</div>
				)}
			</div>

			{stats.elapsedTime && (
				<div className="mt-6 text-center">
					<div className="inline-block cute-badge">
						⏱ Time elapsed:{" "}
						<span className="text-miku-teal font-bold">
							{stats.elapsedTime.hours}h {stats.elapsedTime.minutes}m{" "}
							{stats.elapsedTime.seconds}s
						</span>
					</div>
				</div>
			)}
		</div>
	);
}
