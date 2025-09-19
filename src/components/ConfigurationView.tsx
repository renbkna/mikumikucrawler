import { X, Coffee, Database } from 'lucide-react';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-xl p-6 bg-white rounded-lg shadow-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-emerald-600">
            Advanced Configuration
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-gray-200"
          >
            <X className="w-6 h-6 text-gray-600" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Performance Settings */}
          <div className="p-4 border rounded-lg">
            <h3 className="flex items-center mb-3 text-lg font-semibold text-emerald-600">
              <Coffee className="w-5 h-5 mr-2" />
              Performance Settings
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block mb-1 text-sm font-medium text-gray-700">
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
                  className="w-full px-3 py-2 border border-emerald-200 rounded-lg bg-white text-gray-800 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200"
                  min="1"
                  max="20"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Higher values crawl faster but may overload servers
                </p>
              </div>

              <div>
                <label className="block mb-1 text-sm font-medium text-gray-700">
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
                  className="w-full px-3 py-2 border border-emerald-200 rounded-lg bg-white text-gray-800 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200"
                  min="0"
                  max="10"
                />
                <p className="mt-1 text-xs text-gray-500">
                  How many times to retry failed requests
                </p>
              </div>
            </div>
          </div>

          {/* Content & Behavior Settings */}
          <div className="p-4 border rounded-lg">
            <h3 className="flex items-center mb-3 text-lg font-semibold text-emerald-600">
              <Database className="w-5 h-5 mr-2" />
              Content & Behavior
            </h3>

            <div className="grid grid-cols-1 gap-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="dynamic"
                  checked={options.dynamic}
                  onChange={(e) =>
                    onOptionsChange({
                      ...options,
                      dynamic: e.target.checked,
                    })
                  }
                  className="w-4 h-4 text-emerald-600 border-gray-300 rounded"
                />
                <label
                  htmlFor="dynamic"
                  className="ml-2 text-sm font-medium text-gray-700"
                >
                  Use Dynamic Content (JavaScript Rendering)
                </label>
                <div className="ml-2 text-xs text-gray-500">
                  (Slower but handles modern websites better)
                </div>
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="respectRobots"
                  checked={options.respectRobots}
                  onChange={(e) =>
                    onOptionsChange({
                      ...options,
                      respectRobots: e.target.checked,
                    })
                  }
                  className="w-4 h-4 text-emerald-600 border-gray-300 rounded"
                />
                <label
                  htmlFor="respectRobots"
                  className="ml-2 text-sm font-medium text-gray-700"
                >
                  Respect robots.txt
                </label>
                <div className="ml-2 text-xs text-gray-500">
                  (Be a polite crawler)
                </div>
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="contentOnly"
                  checked={options.contentOnly}
                  onChange={(e) =>
                    onOptionsChange({
                      ...options,
                      contentOnly: e.target.checked,
                    })
                  }
                  className="w-4 h-4 text-emerald-600 border-gray-300 rounded"
                />
                <label
                  htmlFor="contentOnly"
                  className="ml-2 text-sm font-medium text-gray-700"
                >
                  Metadata Only
                </label>
                <div className="ml-2 text-xs text-gray-500">
                  (Don't store full page content - saves memory)
                </div>
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="saveMedia"
                  checked={options.saveMedia}
                  onChange={(e) =>
                    onOptionsChange({
                      ...options,
                      saveMedia: e.target.checked,
                    })
                  }
                  className="w-4 h-4 text-emerald-600 border-gray-300 rounded"
                />
                <label
                  htmlFor="saveMedia"
                  className="ml-2 text-sm font-medium text-gray-700"
                >
                  Process Media Files
                </label>
                <div className="ml-2 text-xs text-gray-500">
                  (Images, PDFs, etc.)
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end mt-6 space-x-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onSave();
                onClose();
              }}
              className="px-4 py-2 text-white bg-emerald-500 rounded-lg hover:bg-emerald-600"
            >
              Save Configuration
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
