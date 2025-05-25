import { Bug, Link2, ExternalLink } from "lucide-react";
import { Stats, QueueStats } from "../types";

interface StatsGridProps {
  stats: Stats;
  queueStats: QueueStats | null;
  isAttacking: boolean;
  isLightTheme: boolean;
}

export function StatsGrid({ stats, queueStats, isAttacking, isLightTheme }: StatsGridProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      {/* Pages Scanned */}
      <div className={`relative p-4 rounded-xl backdrop-blur-sm border transition-all duration-300 hover:scale-105 ${
        isLightTheme
          ? "bg-gradient-to-r from-emerald-50/90 to-cyan-50/90 border-emerald-200/50 shadow-md shadow-emerald-500/10"
          : "bg-gradient-to-r from-emerald-900/30 to-cyan-900/30 border-emerald-700/50 shadow-md shadow-emerald-500/20"
      }`}>
        <div className="relative z-10">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 shadow-md">
                <Bug className="w-4 h-4 text-white" />
              </div>
              <span className={`font-bold text-sm ${
                isLightTheme ? "text-emerald-700" : "text-emerald-400"
              }`}>
                Pages Scanned
              </span>
            </div>
            <div className={`text-2xl font-black ${
              isLightTheme ? "text-gray-800" : "text-white"
            }`}>
              {(stats.pagesScanned || 0).toLocaleString()}
            </div>
          </div>

          {queueStats && isAttacking && (
            <div className="flex items-center gap-2 text-xs">
              <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></div>
              <span className="text-gray-500 font-medium">
                {(queueStats?.pagesPerSecond || 0).toFixed(1)}/sec • Q:{queueStats?.queueLength || 0}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Links Found */}
      <div className={`relative p-4 rounded-xl backdrop-blur-sm border transition-all duration-300 hover:scale-105 ${
        isLightTheme
          ? "bg-gradient-to-r from-cyan-50/90 to-blue-50/90 border-cyan-200/50 shadow-md shadow-cyan-500/10"
          : "bg-gradient-to-r from-cyan-900/30 to-blue-900/30 border-cyan-700/50 shadow-md shadow-cyan-500/20"
      }`}>
        <div className="relative z-10">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 shadow-md">
                <Link2 className="w-4 h-4 text-white" />
              </div>
              <span className={`font-bold text-sm ${
                isLightTheme ? "text-cyan-700" : "text-cyan-400"
              }`}>
                Links Found
              </span>
            </div>
            <div className={`text-2xl font-black ${
              isLightTheme ? "text-gray-800" : "text-white"
            }`}>
              {(stats.linksFound || 0).toLocaleString()}
            </div>
          </div>

          {stats.successCount !== undefined && stats.failureCount !== undefined && (
            <div className="flex items-center gap-3 text-xs">
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-green-400 rounded-full"></div>
                <span className="text-gray-500 font-medium">{stats.successCount}</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-red-400 rounded-full"></div>
                <span className="text-gray-500 font-medium">{stats.failureCount}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Data (KB) */}
      <div className={`relative p-4 rounded-xl backdrop-blur-sm border transition-all duration-300 hover:scale-105 ${
        isLightTheme
          ? "bg-gradient-to-r from-pink-50/90 to-purple-50/90 border-pink-200/50 shadow-md shadow-pink-500/10"
          : "bg-gradient-to-r from-pink-900/30 to-purple-900/30 border-pink-700/50 shadow-md shadow-pink-500/20"
      }`}>
        <div className="relative z-10">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-pink-500 to-purple-600 shadow-md">
                <ExternalLink className="w-4 h-4 text-white" />
              </div>
              <span className={`font-bold text-sm ${
                isLightTheme ? "text-pink-700" : "text-pink-400"
              }`}>
                Data (KB)
              </span>
            </div>
            <div className={`text-2xl font-black ${
              isLightTheme ? "text-gray-800" : "text-white"
            }`}>
              {(stats.totalData || 0).toLocaleString()}
            </div>
          </div>

          {stats.mediaFiles !== undefined && (
            <div className="flex items-center gap-2 text-xs">
              <div className="w-1.5 h-1.5 bg-pink-400 rounded-full"></div>
              <span className="text-gray-500 font-medium">
                {stats.mediaFiles} media
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
