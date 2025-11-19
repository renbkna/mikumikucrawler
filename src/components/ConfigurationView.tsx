import { Coffee, Database, X } from 'lucide-react';
import { CrawlOptions } from '../types';

interface ConfigurationViewProps {
  isOpen: boolean;
  onClose: () => void;
  options: CrawlOptions;
  onOptionsChange: (options: CrawlOptions) => void;
  onSave: () => void;
}

export function ConfigurationView({
  isOpen,
  onClose,
  options,
  onOptionsChange,
  onSave,
}: ConfigurationViewProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="w-full max-w-xl p-6 bg-white rounded-3xl shadow-xl border-2 border-miku-pink/30 max-h-[90vh] overflow-y-auto animate-pop">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-black text-miku-teal tracking-tight">
            Advanced Configuration
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-miku-bg text-slate-400 hover:text-miku-pink transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="space-y-6">
          {/* Performance Settings */}
          <div className="p-5 border-2 border-miku-bg rounded-2xl bg-miku-bg/30">
            <h3 className="flex items-center mb-4 text-lg font-bold text-miku-teal">
              <Coffee className="w-5 h-5 mr-2" />
              Performance Settings
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block mb-2 text-sm font-bold text-slate-600">
                  Max Concurrent Requests
                </label>
                <input
                  type="number"
                  value={options.maxConcurrentRequests}
                  onChange={(e) =>
                    onOptionsChange({
                      ...options,
                      maxConcurrentRequests: Number(e.target.value),
                    })
                  }
                  className="w-full px-4 py-2 border-2 border-white rounded-xl bg-white text-slate-700 focus:border-miku-teal focus:outline-none shadow-sm"
                  min="1"
                  max="20"
                />
                <p className="mt-2 text-xs text-slate-400 font-medium">
                  Higher values crawl faster but may overload servers
                </p>
              </div>

              <div>
                <label className="block mb-2 text-sm font-bold text-slate-600">
                  Retry Limit
                </label>
                <input
                  type="number"
                  value={options.retryLimit}
                  onChange={(e) =>
                    onOptionsChange({
                      ...options,
                      retryLimit: Number(e.target.value),
                    })
                  }
                  className="w-full px-4 py-2 border-2 border-white rounded-xl bg-white text-slate-700 focus:border-miku-teal focus:outline-none shadow-sm"
                  min="0"
                  max="10"
                />
                <p className="mt-2 text-xs text-slate-400 font-medium">
                  How many times to retry failed requests
                </p>
              </div>
            </div>
          </div>

          {/* Content & Behavior Settings */}
          <div className="p-5 border-2 border-miku-bg rounded-2xl bg-miku-bg/30">
            <h3 className="flex items-center mb-4 text-lg font-bold text-miku-teal">
              <Database className="w-5 h-5 mr-2" />
              Content & Behavior
            </h3>

            <div className="grid grid-cols-1 gap-4">
              {[
                {
                  id: 'dynamic',
                  label: 'Use Dynamic Content (JavaScript Rendering)',
                  desc: '(Slower but handles modern websites better)',
                  checked: options.dynamic,
                },
                {
                  id: 'respectRobots',
                  label: 'Respect robots.txt',
                  desc: '(Be a polite crawler)',
                  checked: options.respectRobots,
                },
                {
                  id: 'contentOnly',
                  label: 'Metadata Only',
                  desc: "(Don't store full page content - saves memory)",
                  checked: options.contentOnly,
                },
                {
                  id: 'saveMedia',
                  label: 'Process Media Files',
                  desc: '(Images, PDFs, etc.)',
                  checked: options.saveMedia,
                },
              ].map((item) => (
                <div key={item.id} className="flex items-start">
                  <div className="flex items-center h-5">
                    <input
                      type="checkbox"
                      id={item.id}
                      checked={item.checked}
                      onChange={(e) =>
                        onOptionsChange({
                          ...options,
                          [item.id]: e.target.checked,
                        })
                      }
                      className="w-5 h-5 text-miku-teal border-2 border-slate-300 rounded focus:ring-miku-teal focus:ring-offset-0 cursor-pointer"
                    />
                  </div>
                  <div className="ml-3 text-sm">
                    <label
                      htmlFor={item.id}
                      className="font-bold text-slate-700 cursor-pointer"
                    >
                      {item.label}
                    </label>
                    <p className="text-slate-400 font-medium text-xs mt-0.5">
                      {item.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end mt-8 space-x-3">
            <button
              onClick={onClose}
              className="px-6 py-2.5 text-slate-500 font-bold hover:bg-slate-100 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onSave();
                onClose();
              }}
              className="px-6 py-2.5 text-white font-bold bg-gradient-to-r from-miku-teal to-teal-400 rounded-xl shadow-lg shadow-miku-teal/30 hover:shadow-miku-teal/50 hover:scale-105 transition-all"
            >
              Save Configuration
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
