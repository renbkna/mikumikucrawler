import { Wand2, Zap, Settings } from 'lucide-react';
import { CrawlOptions } from '../types';

interface CrawlerFormProps {
  target: string;
  setTarget: (target: string) => void;
  advancedOptions: CrawlOptions;
  setAdvancedOptions: (options: CrawlOptions) => void;
  isAttacking: boolean;
  startAttack: (isQuick?: boolean) => void;
  stopAttack: () => void;
  setOpenedConfig: (open: boolean) => void;
  isLightTheme: boolean;
}

export function CrawlerForm({
  target,
  setTarget,
  advancedOptions,
  setAdvancedOptions,
  isAttacking,
  startAttack,
  stopAttack,
  setOpenedConfig,
  isLightTheme,
}: CrawlerFormProps) {
  const handleTargetChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTarget = e.target.value;
    setTarget(newTarget);
  };

  return (
    <div className="relative mb-8 space-y-6">
      {/* Main input section with enhanced styling */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* URL Input with beautiful styling */}
        <div className="relative group">
          <label
            className={`block mb-2 text-sm font-semibold ${
              isLightTheme ? 'text-gray-700' : 'text-gray-200'
            }`}
          >
            🎯 Target URL
          </label>
          <div className="relative">
            <input
              type="text"
              value={target}
              onChange={handleTargetChange}
              placeholder="Enter target URL (e.g., https://example.com)"
              className={`w-full px-4 py-3 rounded-xl border-2 transition-all duration-300 focus:scale-[1.02] ${
                isLightTheme
                  ? 'bg-white/80 border-emerald-200 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 text-gray-800 placeholder-gray-500'
                  : 'bg-gray-800/80 border-gray-600 focus:border-cyan-400 focus:ring-4 focus:ring-cyan-400/20 text-white placeholder-gray-300'
              } backdrop-blur-sm shadow-lg`}
              disabled={isAttacking}
            />
            {/* Decorative border gradient */}
            <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-pink-400/20 via-emerald-400/20 to-cyan-400/20 -z-10 blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
          </div>
        </div>

        {/* Action buttons with enhanced styling */}
        <div className="flex flex-col justify-end">
          <label
            className={`block mb-2 text-sm font-semibold ${
              isLightTheme ? 'text-gray-700' : 'text-gray-200'
            }`}
          >
            🚀 Actions
          </label>
          <div className="flex items-center gap-3">
            {/* Main beam button */}
            <button
              onClick={() => (isAttacking ? stopAttack() : startAttack())}
              className={`flex-1 px-4 py-3 rounded-xl font-bold text-white transition-all duration-300 transform hover:scale-105 active:scale-95 shadow-lg ${
                isAttacking
                  ? 'bg-gradient-to-r from-red-500 to-pink-500 hover:from-red-600 hover:to-pink-600 shadow-red-500/30'
                  : 'bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 shadow-emerald-500/30'
              } flex items-center justify-center gap-2`}
            >
              <Wand2 className="w-5 h-5" />
              {isAttacking ? 'Stop Beam' : 'Start Miku Beam'}
            </button>

            {/* Electric beam button (no effects) */}
            <button
              onClick={() => (isAttacking ? stopAttack() : startAttack(true))}
              className={`px-4 py-3 rounded-xl font-bold text-white transition-all duration-300 transform hover:scale-105 active:scale-95 shadow-lg ${
                isAttacking
                  ? 'bg-gradient-to-r from-gray-500 to-gray-600 hover:from-gray-600 hover:to-gray-700'
                  : 'bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 shadow-cyan-500/30'
              } flex items-center justify-center gap-2`}
              title="Electric Beam (No Effects)"
            >
              <Zap className="w-5 h-5" />
            </button>

            {/* Settings button */}
            <button
              className="px-4 py-3 rounded-xl font-bold text-white transition-all duration-300 transform hover:scale-105 active:scale-95 bg-gradient-to-r from-slate-700 to-slate-800 hover:from-slate-800 hover:to-slate-900 shadow-lg shadow-slate-500/30 flex items-center justify-center gap-2"
              onClick={() => setOpenedConfig(true)}
              disabled={isAttacking}
              title="Advanced Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Configuration options with enhanced styling */}
      <div
        className={`p-6 rounded-xl backdrop-blur-sm border ${
          isLightTheme
            ? 'bg-emerald-50/80 border-emerald-200/50'
            : 'bg-gray-800/50 border-gray-600/50'
        }`}
      >
        <h3
          className={`mb-4 text-lg font-bold flex items-center gap-2 ${
            isLightTheme ? 'text-emerald-700' : 'text-emerald-400'
          }`}
        >
          ⚙️ Quick Configuration
        </h3>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Crawl Method */}
          <div className="group">
            <label
              className={`block mb-2 text-sm font-semibold ${
                isLightTheme ? 'text-gray-700' : 'text-gray-200'
              }`}
            >
              🎯 Method
            </label>
            <select
              value={advancedOptions.crawlMethod}
              onChange={(e) =>
                setAdvancedOptions({
                  ...advancedOptions,
                  crawlMethod: e.target.value,
                })
              }
              className={`w-full px-3 py-2 rounded-lg border transition-all duration-300 focus:scale-[1.02] ${
                isLightTheme
                  ? 'bg-white/90 border-emerald-200 focus:border-emerald-400 text-gray-800'
                  : 'bg-gray-600/90 border-gray-500 focus:border-cyan-400 text-white'
              } backdrop-blur-sm shadow-md`}
              disabled={isAttacking}
            >
              <option value="links">🔗 Links Only</option>
              <option value="content">📄 Content + Links</option>
              <option value="media">🖼️ Media Files</option>
              <option value="full">🌐 Full Crawl</option>
            </select>
          </div>

          {/* Max Depth */}
          <div className="group">
            <label
              className={`block mb-2 text-sm font-semibold ${
                isLightTheme ? 'text-gray-700' : 'text-gray-200'
              }`}
            >
              📊 Depth
            </label>
            <input
              type="number"
              value={advancedOptions.crawlDepth}
              onChange={(e) =>
                setAdvancedOptions({
                  ...advancedOptions,
                  crawlDepth: Number(e.target.value),
                })
              }
              className={`w-full px-3 py-2 rounded-lg border transition-all duration-300 focus:scale-[1.02] ${
                isLightTheme
                  ? 'bg-white/90 border-emerald-200 focus:border-emerald-400 text-gray-800'
                  : 'bg-gray-600/90 border-gray-500 focus:border-cyan-400 text-white'
              } backdrop-blur-sm shadow-md`}
              disabled={isAttacking}
              min="1"
              max="5"
            />
          </div>

          {/* Max Pages */}
          <div className="group">
            <label
              className={`block mb-2 text-sm font-semibold ${
                isLightTheme ? 'text-gray-700' : 'text-gray-200'
              }`}
            >
              📈 Pages
            </label>
            <input
              type="number"
              value={advancedOptions.maxPages}
              onChange={(e) =>
                setAdvancedOptions({
                  ...advancedOptions,
                  maxPages: Number(e.target.value),
                })
              }
              className={`w-full px-3 py-2 rounded-lg border transition-all duration-300 focus:scale-[1.02] ${
                isLightTheme
                  ? 'bg-white/90 border-emerald-200 focus:border-emerald-400 text-gray-800'
                  : 'bg-gray-600/90 border-gray-500 focus:border-cyan-400 text-white'
              } backdrop-blur-sm shadow-md`}
              disabled={isAttacking}
              min="1"
              max="200"
            />
          </div>

          {/* Delay */}
          <div className="group">
            <label
              className={`block mb-2 text-sm font-semibold ${
                isLightTheme ? 'text-gray-700' : 'text-gray-200'
              }`}
            >
              ⏱️ Delay (ms)
            </label>
            <input
              type="number"
              value={advancedOptions.crawlDelay}
              onChange={(e) =>
                setAdvancedOptions({
                  ...advancedOptions,
                  crawlDelay: Number(e.target.value),
                })
              }
              className={`w-full px-3 py-2 rounded-lg border transition-all duration-300 focus:scale-[1.02] ${
                isLightTheme
                  ? 'bg-white/90 border-emerald-200 focus:border-emerald-400 text-gray-800'
                  : 'bg-gray-600/90 border-gray-500 focus:border-cyan-400 text-white'
              } backdrop-blur-sm shadow-md`}
              disabled={isAttacking}
              min="500"
              max="5000"
              step="100"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
