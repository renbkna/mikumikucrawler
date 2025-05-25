interface ProgressBarProps {
  progress: number;
  isLightTheme: boolean;
}

export function ProgressBar({ progress, isLightTheme }: ProgressBarProps) {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span
            className={`text-lg font-bold ${
              isLightTheme ? 'text-gray-700' : 'text-gray-200'
            }`}
          >
            🎵 Crawl Progress
          </span>
          {progress > 0 && progress < 100 && (
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 bg-pink-400 rounded-full animate-pulse"></div>
              <span className="text-sm text-gray-500 font-medium">
                In progress...
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-lg font-black ${
              progress === 100
                ? 'text-emerald-500'
                : progress > 0
                ? 'text-pink-500'
                : isLightTheme
                ? 'text-gray-600'
                : 'text-gray-300'
            }`}
          >
            {progress.toFixed(0)}%
          </span>
          {progress === 100 && <span className="text-emerald-500">✨</span>}
        </div>
      </div>

      {/* Enhanced progress bar container */}
      <div
        className={`relative h-6 rounded-full overflow-hidden backdrop-blur-sm border-2 ${
          isLightTheme
            ? 'bg-gray-100/80 border-gray-200/50'
            : 'bg-gray-800/80 border-gray-700/50'
        } shadow-inner`}
      >
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-r from-gray-200/50 to-gray-300/50 dark:from-gray-700/50 dark:to-gray-600/50"></div>

        {/* Progress fill with beautiful gradient */}
        <div
          className="relative h-full transition-all duration-700 ease-out bg-gradient-to-r from-pink-500 via-emerald-500 to-cyan-500 shadow-lg"
          style={{ width: `${progress}%` }}
        >
          {/* Animated shine effect */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-pulse"></div>

          {/* Sparkle effect for active progress */}
          {progress > 0 && progress < 100 && (
            <div className="absolute right-0 top-1/2 transform -translate-y-1/2 translate-x-1">
              <div className="w-3 h-3 bg-white rounded-full shadow-lg animate-ping"></div>
            </div>
          )}
        </div>

        {/* Progress segments for visual appeal */}
        <div className="absolute inset-0 flex">
          {[...Array(10)].map((_, i) => (
            <div
              key={i}
              className={`flex-1 border-r border-white/20 ${
                i === 9 ? 'border-r-0' : ''
              }`}
            ></div>
          ))}
        </div>
      </div>

      {/* Progress status text */}
      <div className="mt-2 text-center">
        {progress === 0 && (
          <span className="text-sm text-gray-500 font-medium">
            Ready to start crawling! 🚀
          </span>
        )}
        {progress > 0 && progress < 100 && (
          <span className="text-sm text-pink-500 font-medium">
            Miku is working hard! 💪
          </span>
        )}
        {progress === 100 && (
          <span className="text-sm text-emerald-500 font-bold">
            Crawl completed successfully! 🎉
          </span>
        )}
      </div>
    </div>
  );
}
