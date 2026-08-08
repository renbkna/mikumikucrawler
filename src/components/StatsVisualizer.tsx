import { PieChart } from "lucide-react";
import type { CrawlCounters, QueueStats } from "../../shared/contracts/index.js";

interface StatsVisualizerProps {
	stats: CrawlCounters;
	queueStats: QueueStats | null;
}

/** Renders success rate, speed, and elapsed time using themed progress indicators. */
export function StatsVisualizer({ stats, queueStats }: Readonly<StatsVisualizerProps>) {
	const successRate = stats.pagesScanned
		? `${((stats.successCount / stats.pagesScanned) * 100).toFixed(1)}%`
		: "0%";
	const elapsedSeconds = queueStats?.elapsedTime ?? 0;
	return (
		<div className="glass-panel p-5 mt-1">
			<h3 className="flex items-center mb-4 font-bold text-miku-teal">
				<PieChart className="w-5 h-5 mr-2" /> Crawl Statistics
			</h3>

			<div className="space-y-4">
				<div>
					<div className="flex justify-between mb-2 text-sm text-miku-text font-medium">
						<span>Success Rate ✧</span>
						<span className="text-emerald-500 font-bold">{successRate}</span>
					</div>
					<div className="h-2.5 bg-miku-pink/8 rounded-full overflow-hidden border border-miku-pink/15">
						<div
							className="h-full bg-emerald-300 rounded-full transition-all duration-500"
							style={{ width: successRate }}
						/>
					</div>
				</div>

				{!!queueStats?.pagesPerSecond && (
					<div>
						<div className="flex justify-between mb-2 text-sm text-miku-text font-medium">
							<span>Speed ♥</span>
							<span className="text-miku-teal font-bold">
								{queueStats.pagesPerSecond.toFixed(2)} pages/sec
							</span>
						</div>
						<div className="h-2.5 bg-miku-teal/8 rounded-full overflow-hidden border border-miku-teal/15">
							<div
								className="h-full bg-miku-teal rounded-full transition-all duration-500"
								style={{
									// Scale: 5 pages/sec = 100% width (Arbitrary visual cap)
									width: `${Math.min(queueStats.pagesPerSecond * 20, 100)}%`,
								}}
							/>
						</div>
					</div>
				)}
			</div>

			{queueStats && (
				<div className="mt-6 text-center">
					<div className="inline-block cute-badge">
						⏱ Time elapsed:{" "}
						<span className="text-miku-teal font-bold">
							{Math.floor(elapsedSeconds / 3600)}h {Math.floor((elapsedSeconds % 3600) / 60)}m{" "}
							{elapsedSeconds % 60}s
						</span>
					</div>
				</div>
			)}
		</div>
	);
}
