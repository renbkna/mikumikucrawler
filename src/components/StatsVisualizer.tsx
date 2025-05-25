import { PieChart } from "lucide-react";
import { Stats } from "../types";

interface StatsVisualizerProps {
  stats: Stats;
}

export function StatsVisualizer({ stats }: StatsVisualizerProps) {
  return (
    <div className="p-4 mt-4 bg-white/10 rounded-lg">
      <h3 className="flex items-center mb-3 font-semibold text-emerald-400">
        <PieChart className="w-4 h-4 mr-2" />
        Crawl Statistics
      </h3>

      {/* Progress bars */}
      <div className="space-y-2">
        {/* Page success rate */}
        {stats.successRate && (
          <div>
            <div className="flex justify-between mb-1 text-xs text-gray-300">
              <span>Success Rate</span>
              <span>{stats.successRate}</span>
            </div>
            <div className="h-2 bg-gray-700 rounded">
              <div
                className="h-full bg-green-500 rounded"
                style={{ width: stats.successRate }}
              ></div>
            </div>
          </div>
        )}

        {/* Pages/second performance */}
        {stats.pagesPerSecond && (
          <div>
            <div className="flex justify-between mb-1 text-xs text-gray-300">
              <span>Speed</span>
              <span>{stats.pagesPerSecond} pages/sec</span>
            </div>
            <div className="h-2 bg-gray-700 rounded">
              <div
                className="h-full bg-blue-500 rounded"
                style={{ width: `${Math.min(Number(stats.pagesPerSecond) * 20, 100)}%` }}
              ></div>
            </div>
          </div>
        )}
      </div>

      {/* Elapsed time */}
      {stats.elapsedTime && (
        <div className="mt-3 text-sm text-center text-emerald-300">
          Time elapsed: {stats.elapsedTime.hours}h {stats.elapsedTime.minutes}m {stats.elapsedTime.seconds}s
        </div>
      )}
    </div>
  );
}
