import { FileText, Globe, Settings, Wand2, Zap } from 'lucide-react';
import type { ChangeEvent } from 'react';
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
  const handleTargetChange = (e: ChangeEvent<HTMLInputElement>) => {
    setTarget(e.target.value);
  };

  return (
    <div className="relative mb-8 space-y-6">
      {/* Main Input Area */}
      <div className="glass-panel rounded-[32px] p-8 relative overflow-hidden group">
        {/* Background decoration */}
        <div className="absolute -right-10 -top-10 w-40 h-40 bg-miku-teal/10 rounded-full blur-3xl group-hover:bg-miku-teal/20 transition-colors duration-500"></div>
        <div className="absolute -left-10 -bottom-10 w-40 h-40 bg-miku-pink/10 rounded-full blur-3xl group-hover:bg-miku-pink/20 transition-colors duration-500"></div>

        <div className="relative z-10 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6 items-end">
          <div className="space-y-3">
            <label className="text-sm font-bold text-slate-500 ml-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-miku-pink animate-pulse"></span>
              TARGET URL
            </label>
            <div className="relative group/input">
                <div className="absolute inset-0 bg-gradient-to-r from-miku-teal to-miku-pink rounded-2xl blur opacity-20 group-hover/input:opacity-40 transition-opacity duration-300"></div>
                <input
                type="text"
                value={target}
                onChange={handleTargetChange}
                placeholder="https://example.com"
                className="relative w-full px-6 py-4 rounded-2xl bg-white border-2 border-transparent focus:border-miku-teal focus:ring-4 focus:ring-miku-teal/10 transition-all duration-300 outline-none text-slate-700 placeholder-slate-300 font-bold text-lg shadow-sm"
                disabled={isAttacking}
                />
            </div>
          </div>

          <div className="flex gap-3">
            {/* Lightning Strike Button */}
            {!isAttacking && (
              <button
                onClick={() => startAttack(true)}
                className="p-4 rounded-2xl bg-yellow-400 text-white hover:bg-yellow-500 hover:scale-105 transition-all duration-300 shadow-lg shadow-yellow-400/30 flex items-center justify-center group/zap"
                title="Lightning Strike (Skip Animation)"
              >
                <Zap className="w-5 h-5 group-hover/zap:fill-white transition-colors" />
              </button>
            )}

            <button
              onClick={() => (isAttacking ? stopAttack() : startAttack())}
              className={`px-6 py-4 rounded-2xl font-black text-white shadow-xl transition-all duration-300 hover:scale-105 active:scale-95 flex items-center gap-3 text-base ${
                isAttacking
                  ? 'bg-gradient-to-r from-miku-pink to-red-400 hover:shadow-miku-pink/40'
                  : 'bg-gradient-to-r from-miku-teal to-[#2cb5ab] hover:shadow-miku-teal/40'
              }`}
            >
              <Wand2 className={`w-5 h-5 ${isAttacking ? 'animate-spin' : 'animate-bounce'}`} />
              {isAttacking ? 'STOP!' : 'MIKU BEAM!'}
            </button>

            <button
              onClick={() => setOpenedConfig(true)}
              className="p-4 rounded-2xl bg-white text-slate-400 hover:text-miku-teal border-2 border-slate-100 hover:border-miku-teal/30 transition-all duration-300 shadow-sm hover:shadow-md hover:rotate-90"
              title="Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Quick Settings Pills */}
      <div className="flex flex-wrap gap-4 justify-center">
        <div className="px-5 py-2.5 rounded-full bg-white/60 border-2 border-white text-sm font-bold text-slate-500 flex items-center gap-2 shadow-sm hover:scale-105 transition-transform">
          <Globe className="w-4 h-4 text-miku-teal" />
          Depth: <span className="text-miku-teal">{advancedOptions.crawlDepth}</span>
        </div>
        <div className="px-5 py-2.5 rounded-full bg-white/60 border-2 border-white text-sm font-bold text-slate-500 flex items-center gap-2 shadow-sm hover:scale-105 transition-transform">
          <FileText className="w-4 h-4 text-miku-pink" />
          Pages: <span className="text-miku-pink">{advancedOptions.maxPages}</span>
        </div>
        <div className="px-5 py-2.5 rounded-full bg-white/60 border-2 border-white text-sm font-bold text-slate-500 flex items-center gap-2 shadow-sm hover:scale-105 transition-transform">
          <Zap className="w-4 h-4 text-yellow-400" />
          Delay: <span className="text-yellow-500">{advancedOptions.crawlDelay}ms</span>
        </div>
      </div>
    </div>
  );
}
