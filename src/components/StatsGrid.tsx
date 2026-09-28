import {
	Activity,
	Bug,
	CheckCircle,
	Database,
	Link2,
	type LucideIcon,
	XCircle,
} from "lucide-react";
import { memo, type ReactNode } from "react";
import type { CrawlCounters } from "../../shared/contracts/index.js";
import type { QueueStats } from "../../shared/contracts/pageData.js";

const METRIC_TONES = {
	teal: { icon: "text-miku-teal", title: "text-miku-teal-dark" },
	pink: { icon: "text-miku-pink", title: "text-miku-pink-dark" },
} as const;

function MetricCard({
	className,
	icon: Icon,
	tone,
	title,
	value,
	children,
}: Readonly<{
	className: string;
	icon: LucideIcon;
	tone: keyof typeof METRIC_TONES;
	title: string;
	value: ReactNode;
	children?: ReactNode;
}>) {
	return (
		<div className={`metric-card ${className} cute-card p-5 pb-8 relative overflow-hidden group`}>
			<div className="relative z-10">
				<div className="flex items-center gap-2 mb-3">
					<div className={METRIC_TONES[tone].icon}>
						<Icon className="w-5 h-5" />
					</div>
					<h3
						className={`font-bold ${METRIC_TONES[tone].title} text-sm uppercase tracking-wider flex items-center gap-1`}
					>
						{title}
					</h3>
				</div>

				<div className="text-4xl font-semibold text-miku-accent/80 mb-3 tracking-tight">
					{value}
				</div>

				{children}
			</div>
		</div>
	);
}

interface StatsGridProps {
	stats: CrawlCounters;
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
			<MetricCard
				className="metric-pages"
				icon={Bug}
				tone="teal"
				title="Pages"
				value={stats.pagesScanned.toLocaleString()}
			>
				{queueStats && isAttacking && (
					<div className="flex items-center gap-2 text-xs font-semibold text-miku-teal-dark px-1 py-1 w-fit">
						<Activity className="w-3 h-3 animate-pulse" />
						<span>{queueStats.pagesPerSecond.toFixed(1)} / sec</span>
					</div>
				)}
			</MetricCard>

			<MetricCard
				className="metric-links"
				icon={Link2}
				tone="pink"
				title="Links"
				value={stats.linksFound.toLocaleString()}
			>
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
			</MetricCard>

			<MetricCard
				className="metric-data"
				icon={Database}
				tone="teal"
				title="Data"
				value={
					<>
						{stats.totalDataKb.toLocaleString()}{" "}
						<span className="text-lg text-miku-text/50 font-medium">KB</span>
					</>
				}
			>
				<div className="text-xs font-semibold text-miku-accent/70 px-1 py-1 w-fit">
					{stats.mediaFiles} media files
				</div>
			</MetricCard>
		</div>
	);
});
