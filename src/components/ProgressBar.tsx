import { Music } from 'lucide-react';

interface ProgressBarProps {
  progress: number;
  isLightTheme: boolean;
}

export function ProgressBar({ progress, isLightTheme }: ProgressBarProps) {
  return (
    <div className="mb-8 relative">
      <div className="flex items-center justify-between mb-3 px-2">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-slate-600 flex items-center gap-2">
            <Music className={`w-5 h-5 ${progress > 0 && progress < 100 ? 'animate-bounce' : ''} text-miku-primary`} />
            Crawl Progress
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-2xl font-black text-miku-primary">
            {progress.toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Progress Bar Container */}
      <div className="relative h-8 rounded-full bg-slate-200/50 overflow-hidden shadow-inner border border-white/50">
        {/* Animated Background Pattern */}
        <div className="absolute inset-0 opacity-30"
             style={{
               backgroundImage: 'radial-gradient(#39C5BB 1px, transparent 1px)',
               backgroundSize: '10px 10px'
             }}>
        </div>

        {/* Progress Fill */}
        <div
          className="relative h-full transition-all duration-700 ease-out bg-gradient-to-r from-miku-primary via-miku-secondary to-miku-primary bg-[length:200%_100%] animate-gradient-shift shadow-lg rounded-full"
          style={{ width: `${progress}%` }}
        >
          {/* Shine Effect */}
          <div className="absolute inset-0 bg-gradient-to-b from-white/30 to-transparent"></div>

          {/* Leading Sparkle */}
          {progress > 0 && progress < 100 && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              <div className="w-2 h-2 bg-white rounded-full animate-ping"></div>
            </div>
          )}
        </div>
      </div>

      {/* Status Message */}
      <div className="mt-3 text-center h-6">
        {progress > 0 && progress < 100 && (
          <span className="text-sm font-bold text-miku-secondary animate-pulse">
            Miku is working hard! Ganbare! ♪
          </span>
        )}
        {progress === 100 && (
          <span className="text-sm font-bold text-miku-primary animate-bounce">
            All done! Sugoi! ✨
          </span>
        )}
      </div>
    </div>
  );
}
