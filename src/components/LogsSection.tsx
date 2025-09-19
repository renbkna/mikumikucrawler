import { RefObject } from "react";

interface LogsSectionProps {
  logs: string[];
  setLogs: (logs: string[]) => void;
  logContainerRef: RefObject<HTMLDivElement>;
}

export function LogsSection({ logs, setLogs, logContainerRef }: LogsSectionProps) {
  return (
    <div className="relative p-6 font-mono text-sm bg-gradient-to-br from-gray-900/95 to-gray-800/95 backdrop-blur-sm rounded-2xl border border-gray-700/50 shadow-2xl mb-6">
      {/* Decorative background elements */}
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-900/10 to-cyan-900/10 rounded-2xl pointer-events-none"></div>

      {/* Header */}
      <div className="relative z-10 flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 bg-emerald-400 rounded-full animate-pulse shadow-lg shadow-emerald-400/50"></div>
          <h3 className="text-lg font-bold text-emerald-400 flex items-center gap-2">
            🖥️ Crawler Logs
          </h3>
          <div className="px-2 py-1 bg-emerald-400/20 rounded-full text-xs text-emerald-300 font-medium">
            {logs.length} entries
          </div>
        </div>

        <button
          className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-red-500/80 to-pink-500/80 rounded-lg hover:from-red-600/80 hover:to-pink-600/80 transition-all duration-300 transform hover:scale-105 active:scale-95 shadow-lg backdrop-blur-sm border border-red-400/30"
          onClick={() => setLogs([])}
        >
          🗑️ Clear
        </button>
      </div>

      {/* Logs container */}
      <div
        className="relative z-10 text-emerald-300 max-h-48 overflow-y-auto scrollbar-thin scrollbar-thumb-emerald-500/50 scrollbar-track-gray-800/50"
        ref={logContainerRef}
      >
        {logs.length ? (
          <div className="space-y-1">
            {logs.map((log, i) => (
              <div
                key={i}
                className="group py-2 px-3 border-l-2 border-emerald-500/30 hover:border-emerald-400/60 hover:bg-emerald-900/20 rounded-r-lg transition-all duration-200"
              >
                <div className="flex items-start gap-2">
                  <span className="text-emerald-500 font-bold text-xs mt-0.5 opacity-60">
                    {String(logs.length - i).padStart(2, '0')}
                  </span>
                  <span className="text-emerald-400 font-bold">{">"}</span>
                  <span className="flex-1 leading-relaxed">{log}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center py-8">
            <div className="text-center">
              <div className="text-4xl mb-2">🌸</div>
              <div className="text-gray-400 italic font-medium">
                <span className="text-emerald-400 font-bold">{">"}</span> Waiting for Miku's crawler beam...
              </div>
              <div className="text-xs text-gray-500 mt-1">Logs will appear here when crawling starts</div>
            </div>
          </div>
        )}
      </div>

      {/* Terminal-style bottom bar */}
      <div className="relative z-10 mt-4 pt-3 border-t border-gray-700/50">
        <div className="flex items-center justify-between text-xs text-gray-400">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></div>
            <span>Terminal Ready</span>
          </div>
          <div className="flex items-center gap-4">
            <span>Lines: {logs.length}</span>
            <span>Status: {logs.length > 0 ? "Active" : "Idle"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
