import { Terminal, Trash2 } from "lucide-react";
import { RefObject } from "react";

interface LogsSectionProps {
  logs: string[];
  setLogs: (logs: string[]) => void;
  logContainerRef: RefObject<HTMLDivElement>;
}

export function LogsSection({ logs, setLogs, logContainerRef }: LogsSectionProps) {
  return (
    <div className="h-full flex flex-col relative">
      {/* Notebook binding effect */}
      <div className="absolute left-6 top-0 bottom-0 w-px border-r-2 border-dashed border-miku-teal/20 z-0"></div>

      <div className="flex-1 rounded-[20px] relative z-10 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 pl-8">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-white shadow-sm text-miku-teal border border-miku-teal/20">
              <Terminal className="w-4 h-4" />
            </div>
            <span className="px-3 py-1 rounded-full bg-miku-teal/10 text-xs font-bold text-miku-teal border border-miku-teal/20">
              {logs.length} entries
            </span>
          </div>

          <button
            onClick={() => setLogs([])}
            className="p-2 rounded-full hover:bg-rose-50 text-slate-300 hover:text-rose-500 transition-colors"
            title="Clear Logs"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>

        {/* Logs Container */}
        <div
          className="flex-1 overflow-y-auto pl-8 pr-2 space-y-3 scrollbar-thin scrollbar-thumb-miku-teal/20 scrollbar-track-transparent"
          ref={logContainerRef}
        >
          {logs.length > 0 ? (
            logs.map((log, i) => (
              <div
                key={i}
                className="text-sm font-medium text-slate-600 py-3 border-b border-slate-100 last:border-0 flex gap-4 group hover:bg-white/40 rounded-xl px-3 transition-all"
              >
                <span className="text-miku-teal/40 font-mono text-xs mt-0.5 select-none font-bold">
                  {String(logs.length - i).padStart(2, '0')}
                </span>
                <span className="leading-relaxed">{log}</span>
              </div>
            ))
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 italic">
              <div className="text-5xl mb-4 opacity-50 animate-bounce-slow">📝</div>
              <p className="font-medium">Waiting for Miku to start writing...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
