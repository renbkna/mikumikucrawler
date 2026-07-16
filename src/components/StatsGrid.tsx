import { Activity, Bug, CheckCircle, Database, Link2, XCircle } from "lucide-react";
import { memo } from "react";
import type { QueueStats, Stats } from "../../shared/types.js";
import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface StatsGridProps {
	stats: Stats;
	queueStats: QueueStats | null;
	isAttacking: boolean;
}

export const StatsGrid = memo(function StatsGrid({
	stats,
	queueStats,
	isAttacking,
}: StatsGridProps) {
	return (
		<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
			<div className="metric-card metric-pages cute-card p-5 pb-8 relative overflow-hidden group">
				<div className="hidden" />

				<div className="relative z-10">
					<div className="flex items-center gap-2 mb-3">
						<div className="text-miku-teal">
							<Bug className="w-5 h-5" />
						</div>
						<h3 className="font-bold text-miku-teal-dark text-sm uppercase tracking-wider flex items-center gap-1">
							Pages <NoteIcon className="hidden" size={12} />
						</h3>
					</div>

					<div className="text-4xl font-semibold text-miku-accent/80 mb-3 tracking-tight">
						{(stats.pagesScanned || 0).toLocaleString()}
					</div>

					{queueStats && isAttacking && (
						<div className="flex items-center gap-2 text-xs font-semibold text-miku-teal-dark px-1 py-1 w-fit">
							<Activity className="w-3 h-3 animate-pulse" />
							<span>{(queueStats.pagesPerSecond || 0).toFixed(1)} / sec</span>
							<SparkleIcon className="hidden" size={10} />
						</div>
					)}
				</div>
			</div>

			<div className="metric-card metric-links cute-card p-5 pb-8 relative overflow-hidden group">
				<div className="hidden" />

				<div className="relative z-10">
					<div className="flex items-center gap-2 mb-3">
						<div className="text-miku-pink">
							<Link2 className="w-5 h-5" />
						</div>
						<h3 className="font-bold text-miku-pink-dark text-sm uppercase tracking-wider flex items-center gap-1">
							Links <HeartIcon className="hidden" size={12} />
						</h3>
					</div>

					<div className="text-4xl font-semibold text-miku-accent/80 mb-3 tracking-tight">
						{(stats.linksFound || 0).toLocaleString()}
					</div>

					<div className="flex gap-2">
						<div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-500 px-1 py-1">
							<CheckCircle className="w-3 h-3" />
							{stats.successCount}
						</div>
						<div className="flex items-center gap-1.5 text-xs font-semibold text-rose-400 px-1 py-1">
							<XCircle className="w-3 h-3" />
							{stats.failureCount}
						</div>
					</div>
				</div>
			</div>

			<div className="metric-card metric-data cute-card p-5 pb-8 relative overflow-hidden group">
				<div className="hidden" />

				<div className="relative z-10">
					<div className="flex items-center gap-2 mb-3">
						<div className="text-miku-teal">
							<Database className="w-5 h-5" />
						</div>
						<h3 className="font-bold text-miku-teal-dark text-sm uppercase tracking-wider flex items-center gap-1">
							Data <SparkleIcon className="hidden" size={12} />
						</h3>
					</div>

					<div className="text-4xl font-semibold text-miku-accent/80 mb-3 tracking-tight">
						{(stats.totalData || 0).toLocaleString()}{" "}
						<span className="text-lg text-miku-text/50 font-medium">KB</span>
					</div>

					<div className="text-xs font-semibold text-miku-accent/70 px-1 py-1 w-fit">
						{stats.mediaFiles} media files
					</div>
				</div>
			</div>
		</div>
	);
});

StatsGrid.displayName = "StatsGrid";
