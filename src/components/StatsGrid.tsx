import { Activity, Bug, CheckCircle, Database, Link2, XCircle } from "lucide-react";
import { QueueStats, Stats } from "../types";

interface StatsGridProps {
  stats: Stats;
  queueStats: QueueStats | null;
  isAttacking: boolean;
  isLightTheme: boolean;
}

export function StatsGrid({ stats, queueStats, isAttacking }: StatsGridProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
      {/* Pages Scanned Card */}
      <div className="cute-card p-6 relative overflow-hidden group">
        <div className="absolute -right-6 -top-6 w-24 h-24 bg-miku-teal/10 rounded-full group-hover:scale-150 transition-transform duration-500" />

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 rounded-2xl bg-miku-teal/10 text-miku-teal shadow-sm">
              <Bug className="w-6 h-6" />
            </div>
            <h3 className="font-bold text-slate-500 text-sm uppercase tracking-wider">Pages Scanned</h3>
          </div>

          <div className="text-5xl font-black text-slate-700 mb-3 tracking-tight">
            {(stats.pagesScanned || 0).toLocaleString()}
          </div>

          {queueStats && isAttacking && (
            <div className="flex items-center gap-2 text-xs font-bold text-miku-teal bg-miku-teal/5 rounded-full px-3 py-1.5 w-fit border border-miku-teal/20">
              <Activity className="w-3 h-3 animate-pulse" />
              <span>{(queueStats?.pagesPerSecond || 0).toFixed(1)} / sec</span>
            </div>
          )}
        </div>
      </div>

      {/* Links Found Card */}
      <div className="cute-card p-6 relative overflow-hidden group">
        <div className="absolute -right-6 -top-6 w-24 h-24 bg-miku-pink/10 rounded-full group-hover:scale-150 transition-transform duration-500" />

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 rounded-2xl bg-miku-pink/10 text-miku-pink shadow-sm">
              <Link2 className="w-6 h-6" />
            </div>
            <h3 className="font-bold text-slate-500 text-sm uppercase tracking-wider">Links Found</h3>
          </div>

          <div className="text-5xl font-black text-slate-700 mb-3 tracking-tight">
            {(stats.linksFound || 0).toLocaleString()}
          </div>

          <div className="flex gap-2">
            <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-600 bg-emerald-50 border border-emerald-100 px-2.5 py-1 rounded-full">
              <CheckCircle className="w-3 h-3" />
              {stats.successCount}
            </div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-rose-500 bg-rose-50 border border-rose-100 px-2.5 py-1 rounded-full">
              <XCircle className="w-3 h-3" />
              {stats.failureCount}
            </div>
          </div>
        </div>
      </div>

      {/* Data Card */}
      <div className="cute-card p-6 relative overflow-hidden group">
        <div className="absolute -right-6 -top-6 w-24 h-24 bg-purple-100 rounded-full group-hover:scale-150 transition-transform duration-500" />

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 rounded-2xl bg-purple-50 text-purple-500 shadow-sm">
              <Database className="w-6 h-6" />
            </div>
            <h3 className="font-bold text-slate-500 text-sm uppercase tracking-wider">Data Collected</h3>
          </div>

          <div className="text-5xl font-black text-slate-700 mb-3 tracking-tight">
            {(stats.totalData || 0).toLocaleString()} <span className="text-xl text-slate-300 font-bold">KB</span>
          </div>

          <div className="text-xs font-bold text-purple-500 bg-purple-50 border border-purple-100 rounded-full px-3 py-1.5 w-fit">
            {stats.mediaFiles} media files
          </div>
        </div>
      </div>
    </div>
  );
}
