import { 
  Zap, 
  Bug, 
  Link2, 
  ExternalLink, 
  ScrollText, 
  Wand2, 
  Download, 
  AlertCircle, 
  Settings, 
  X, 
  PieChart,
  Filter,
  Database,
  Coffee
} from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";

// Extended interfaces for better type safety
interface Stats {
  pagesScanned: number;
  linksFound: number;
  totalData: number; // in KB
  mediaFiles?: number;
  successCount?: number;
  failureCount?: number;
  skippedCount?: number;
  elapsedTime?: {
    hours: number;
    minutes: number;
    seconds: number;
  };
  pagesPerSecond?: string;
  successRate?: string;
}

interface QueueStats {
  activeRequests: number;
  queueLength: number;
  elapsedTime: number;
  pagesPerSecond: number;
}

interface StatsPayload extends Partial<Stats> {
  log?: string;
}

interface CrawledPage {
  url: string;
  content: string;
  title?: string;
  description?: string;
  contentType?: string;
  domain?: string;
}

// Crawl configuration options
interface CrawlOptions {
  target: string;
  crawlMethod: string;
  crawlDepth: number;
  crawlDelay: number;
  maxPages: number;
  maxConcurrentRequests: number;
  retryLimit: number;
  dynamic: boolean;
  respectRobots: boolean;
  contentOnly: boolean;
  saveMedia: boolean;
}

// Toast notification system
interface Toast {
  id: number;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  timeout: number;
}

function ConfigurationView({ 
  isOpen, 
  onClose, 
  options, 
  onOptionsChange,
  onSave
}: { 
  isOpen: boolean;
  onClose: () => void;
  options: CrawlOptions;
  onOptionsChange: (options: CrawlOptions) => void;
  onSave: () => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-xl p-6 bg-white rounded-lg shadow-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-emerald-600">Advanced Configuration</h2>
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
                  onChange={(e) => onOptionsChange({
                    ...options,
                    maxConcurrentRequests: Number(e.target.value)
                  })}
                  className="w-full px-3 py-2 border border-emerald-200 rounded-lg"
                  min="1"
                  max="20"
                />
                <p className="mt-1 text-xs text-gray-500">Higher values crawl faster but may overload servers</p>
              </div>
              
              <div>
                <label className="block mb-1 text-sm font-medium text-gray-700">
                  Retry Limit
                </label>
                <input
                  type="number"
                  value={options.retryLimit}
                  onChange={(e) => onOptionsChange({
                    ...options,
                    retryLimit: Number(e.target.value)
                  })}
                  className="w-full px-3 py-2 border border-emerald-200 rounded-lg"
                  min="0"
                  max="10"
                />
                <p className="mt-1 text-xs text-gray-500">How many times to retry failed requests</p>
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
                  onChange={(e) => onOptionsChange({
                    ...options,
                    dynamic: e.target.checked
                  })}
                  className="w-4 h-4 text-emerald-600 border-gray-300 rounded"
                />
                <label htmlFor="dynamic" className="ml-2 text-sm font-medium text-gray-700">
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
                  onChange={(e) => onOptionsChange({
                    ...options,
                    respectRobots: e.target.checked
                  })}
                  className="w-4 h-4 text-emerald-600 border-gray-300 rounded"
                />
                <label htmlFor="respectRobots" className="ml-2 text-sm font-medium text-gray-700">
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
                  onChange={(e) => onOptionsChange({
                    ...options,
                    contentOnly: e.target.checked
                  })}
                  className="w-4 h-4 text-emerald-600 border-gray-300 rounded"
                />
                <label htmlFor="contentOnly" className="ml-2 text-sm font-medium text-gray-700">
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
                  onChange={(e) => onOptionsChange({
                    ...options,
                    saveMedia: e.target.checked
                  })}
                  className="w-4 h-4 text-emerald-600 border-gray-300 rounded"
                />
                <label htmlFor="saveMedia" className="ml-2 text-sm font-medium text-gray-700">
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

// Toast Notification Component
function ToastNotification({ toast, onDismiss }: { toast: Toast, onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, toast.timeout);
    
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);
  
  const bgColors = {
    success: 'bg-green-500',
    error: 'bg-red-500',
    warning: 'bg-yellow-500',
    info: 'bg-blue-500'
  };
  
  return (
    <div className={`${bgColors[toast.type]} text-white px-4 py-3 rounded-lg shadow-lg flex items-center justify-between max-w-xs sm:max-w-md`}>
      <div className="mr-2">{toast.message}</div>
      <button onClick={() => onDismiss(toast.id)} className="text-white hover:text-gray-200">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// Display a crawled page inside an iframe with better controls
function CrawledPageDisplay({ page, onClose }: { page: CrawledPage, onClose?: () => void }) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  return (
    <div className={`py-2 border-b border-green-700 ${isExpanded ? 'bg-white/10' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="font-bold break-text">{page.title || page.url}</div>
        <div className="flex space-x-2">
          <button 
            onClick={() => setIsExpanded(!isExpanded)}
            className="px-2 py-1 text-xs text-white bg-emerald-600 rounded hover:bg-emerald-700"
          >
            {isExpanded ? 'Hide' : 'View'}
          </button>
          {onClose && (
            <button 
              onClick={onClose}
              className="px-2 py-1 text-xs text-white bg-red-600 rounded hover:bg-red-700"
            >
              Close
            </button>
          )}
        </div>
      </div>
      
      {page.description && (
        <div className="mb-2 text-sm text-gray-400">{page.description}</div>
      )}
      
      {isExpanded && (
        <div className="mt-2">
          {page.contentType?.includes('text/html') ? (
            <iframe
              srcDoc={page.content}
              title={page.url}
              sandbox="allow-same-origin"
              className="w-full h-96 bg-white rounded border border-gray-600"
            />
          ) : (
            <div className="p-4 overflow-auto text-sm bg-gray-800 rounded h-44">
              <pre>{page.content}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Data visualization component
function StatsVisualizer({ stats }: { stats: Stats }) {
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

// Export options dialog
function ExportDialog({ isOpen, onClose, onExport }: { 
  isOpen: boolean; 
  onClose: () => void; 
  onExport: (format: string) => void;
}) {
  if (!isOpen) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md p-6 bg-white rounded-lg shadow-lg">
        <h2 className="mb-4 text-xl font-bold text-emerald-600">Export Crawled Data</h2>
        
        <div className="space-y-4">
          <button
            onClick={() => {
              onExport('json');
              onClose();
            }}
            className="flex items-center justify-between w-full p-3 border rounded-lg hover:bg-gray-100"
          >
            <span className="font-medium">JSON Format</span>
            <Download className="w-5 h-5 text-emerald-600" />
          </button>
          
          <button
            onClick={() => {
              onExport('csv');
              onClose();
            }}
            className="flex items-center justify-between w-full p-3 border rounded-lg hover:bg-gray-100"
          >
            <span className="font-medium">CSV Format</span>
            <Download className="w-5 h-5 text-emerald-600" />
          </button>
        </div>
        
        <div className="flex justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [isAttacking, setIsAttacking] = useState(false);
  const [animState, setAnimState] = useState<number>(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<number>(0);

  // For crawler config
  const [target, setTarget] = useState<string>("");
  const [advancedOptions, setAdvancedOptions] = useState<CrawlOptions>({
    target: "",
    crawlMethod: "links",
    crawlDepth: 2,
    crawlDelay: 1000,
    maxPages: 50,
    maxConcurrentRequests: 5,
    retryLimit: 3,
    dynamic: true,
    respectRobots: true,
    contentOnly: false,
    saveMedia: false
  });
  
  // UI state
  const [audioVol, setAudioVol] = useState<number>(100);
  const [crawledPages, setCrawledPages] = useState<CrawledPage[]>([]);
  const [filteredPages, setFilteredPages] = useState<CrawledPage[]>([]);
  const [selectedPage, setSelectedPage] = useState<CrawledPage | null>(null);
  const [openedConfig, setOpenedConfig] = useState(false);
  const [openExportDialog, setOpenExportDialog] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [isFilterActive, setIsFilterActive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [currentTask, setCurrentTask] = useState<NodeJS.Timeout | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  
  const audioRef = useRef<HTMLAudioElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Stats tracking
  const [stats, setStats] = useState<Stats>({
    pagesScanned: 0,
    linksFound: 0,
    totalData: 0,
    mediaFiles: 0,
    successCount: 0,
    failureCount: 0,
    skippedCount: 0
  });

  // Toast notification system
  const addToast = useCallback((type: 'success' | 'error' | 'info' | 'warning', message: string, timeout = 3000) => {
    const id = Date.now();
    setToasts(prevToasts => [...prevToasts, { id, type, message, timeout }]);
  }, []);
  
  const dismissToast = useCallback((id: number) => {
    setToasts(prevToasts => prevToasts.filter(toast => toast.id !== id));
  }, []);

  // Connect to backend using the environment variable (VITE_BACKEND_URL)
  useEffect(() => {
    const socketEndpoint = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";
    console.log(`Connecting to backend at ${socketEndpoint}`);
    
    try {
      const newSocket = io(socketEndpoint, { 
        transports: ["websocket"],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 10000
      });
      
      newSocket.on("connect", () => {
        console.log("Connected to backend");
        addToast('success', 'Connected to crawler backend');
        setSocket(newSocket);
      });
      
      newSocket.on("connect_error", (err) => {
        console.error("Connection error:", err);
        addToast('error', `Connection error: ${err.message}`);
      });

      newSocket.on("stats", (data: StatsPayload) => {
        // Merge new stats
        setStats((old) => ({
          pagesScanned: data.pagesScanned ?? old.pagesScanned,
          linksFound: data.linksFound ?? old.linksFound,
          totalData: data.totalData ?? old.totalData,
          mediaFiles: data.mediaFiles ?? old.mediaFiles,
          successCount: data.successCount ?? old.successCount,
          failureCount: data.failureCount ?? old.failureCount,
          skippedCount: data.skippedCount ?? old.skippedCount,
          elapsedTime: data.elapsedTime ?? old.elapsedTime,
          pagesPerSecond: data.pagesPerSecond ?? old.pagesPerSecond,
          successRate: data.successRate ?? old.successRate
        }));
        
        if (data.log) {
          addLog(data.log);
        }
        
        // Update progress
        setProgress((prev) => {
          // Create a smoother progress that accelerates as we go through the crawl
          const newProgress = Math.min(
            (data.pagesScanned || 0) / (advancedOptions.maxPages * 0.8) * 100, 
            99
          );
          return Math.max(prev, newProgress); // Never go backwards
        });
      });
      
      newSocket.on("queueStats", (data: QueueStats) => {
        setQueueStats(data);
      });

      newSocket.on("pageContent", (data: CrawledPage) => {
        setCrawledPages((prev) => {
          const newPages = [data, ...prev];
          // Update filtered pages if filter is active
          if (isFilterActive) {
            setFilteredPages(filterPages(newPages, filterText));
          }
          return newPages;
        });
      });
      
      newSocket.on("exportResult", (data: { data: string, format: string }) => {
        // Create a blob and download link
        const blob = new Blob([data.data], { 
          type: data.format === 'json' 
            ? 'application/json' 
            : 'text/csv' 
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `miku-crawler-export.${data.format}`;
        document.body.appendChild(a);
        a.click();
        
        // Clean up
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
        
        addToast('success', `Data exported successfully as ${data.format.toUpperCase()}`);
      });
      
      newSocket.on("error", (error: { message: string }) => {
        addToast('error', error.message);
      });

      newSocket.on("attackEnd", (finalStats: Stats) => {
        setIsAttacking(false);
        addLog("🛑 Crawl ended.");
        setStats(finalStats);
        setProgress(100); // Complete the progress bar
        
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.currentTime = 0;
        }
        
        // Show completion toast
        addToast(
          'success', 
          `Crawl completed! Scanned ${finalStats.pagesScanned} pages in ${
            finalStats.elapsedTime 
              ? `${finalStats.elapsedTime.hours}h ${finalStats.elapsedTime.minutes}m ${finalStats.elapsedTime.seconds}s` 
              : 'some time'
          }`,
          5000
        );
      });

      newSocket.on("disconnect", () => {
        console.log("Disconnected from backend");
        addToast('warning', 'Disconnected from crawler backend');
      });

      return () => {
        newSocket.close();
      };
    } catch (error) {
      console.error("Socket initialization error:", error);
      addToast('error', `Failed to connect to backend: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [addToast, advancedOptions.maxPages, filterText, isFilterActive]);

  // Audio management for the attack animation/sound
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handler = () => {
      if (audio.paused) return;
      if (animState !== 2 && audio.currentTime > 5.24 && audio.currentTime < 9.4) {
        setAnimState(2);
      }
      if (audio.currentTime > 17.53) {
        audio.currentTime = 15.86;
      }
    };
    audio.addEventListener("timeupdate", handler);
    return () => audio.removeEventListener("timeupdate", handler);
  }, [animState]);

  // Clean up timeouts when attack state changes
  useEffect(() => {
    if (!isAttacking) {
      if (currentTask) {
        clearTimeout(currentTask);
      }
    }
  }, [isAttacking, currentTask]);

  // Log management
  const addLog = (msg: string) => {
    setLogs((prev) => {
      const newLogs = [msg, ...prev].slice(0, 30); // Keep more logs (30 instead of 12)
      return newLogs;
    });
    
    // Scroll to the bottom of the log container
    if (logContainerRef.current) {
      setTimeout(() => {
        if (logContainerRef.current) {
          logContainerRef.current.scrollTop = 0;
        }
      }, 10);
    }
  };

  // Handle target input changes
  const handleTargetChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTarget = e.target.value;
    setTarget(newTarget);
    
    // Also update the target in advanced options
    setAdvancedOptions(prev => ({
      ...prev,
      target: newTarget
    }));
  };

  // Filtering functions for crawled pages
  const filterPages = (pages: CrawledPage[], filterString: string): CrawledPage[] => {
    if (!filterString.trim()) return pages;
    
    const lowerFilter = filterString.toLowerCase();
    return pages.filter(page => 
      page.url.toLowerCase().includes(lowerFilter) || 
      (page.title && page.title.toLowerCase().includes(lowerFilter)) || 
      (page.description && page.description.toLowerCase().includes(lowerFilter))
    );
  };
  
  const handleFilterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const filter = e.target.value;
    setFilterText(filter);
    setFilteredPages(filterPages(crawledPages, filter));
    setIsFilterActive(!!filter.trim());
  };

  // Attack control functions
  const validateTarget = (url: string): boolean => {
    try {
      // Add http:// prefix if missing
      if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
        setTarget(url);
        setAdvancedOptions(prev => ({ ...prev, target: url }));
      }
      
      new URL(url); // Will throw if invalid
      return true;
    } catch (e) {
      addToast('error', 'Please enter a valid URL');
      return false;
    }
  };

  const startAttack = (isQuick = false) => {
    if (!target.trim()) {
      addToast('error', 'Please enter a target URL!');
      return;
    }
    
    if (!validateTarget(target)) {
      return;
    }
    
    if (!socket) {
      addToast('error', 'Socket not connected! Please wait or refresh the page.');
      return;
    }

    // Reset stats and logs for a new crawl session
    setStats({ 
      pagesScanned: 0, 
      linksFound: 0, 
      totalData: 0,
      mediaFiles: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0
    });
    setCrawledPages([]);
    setFilteredPages([]);
    setSelectedPage(null);
    setProgress(0);
    addLog("🕷️ Preparing miku beam...");

    if (audioRef.current) {
      audioRef.current.currentTime = isQuick ? 9.5 : 0;
      audioRef.current.volume = audioVol / 100;
      audioRef.current.play().catch(console.error);
    }

    if (!isQuick) setAnimState(1);

    const timeout = setTimeout(() => {
      setAnimState(3);
      
      // Update target in options before sending
      const optionsToSend = {
        ...advancedOptions,
        target: target
      };
      
      socket.emit("startAttack", optionsToSend);
      
      addToast('info', `Started crawling ${target}`);
    }, isQuick ? 700 : 10250);
    setCurrentTask(timeout);

    setIsAttacking(true);
    addLog(`🌐 Starting crawl on ${target}`);
    addLog("📡 Scanning for links and data...");
  };

  const stopAttack = () => {
    if (socket) {
      socket.emit("stopAttack");
      addLog("🛑 Stopped crawler beam.");
      addToast('info', 'Crawler stopped');
    }
  };

  // Volume control
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = audioVol / 100;
    }
  }, [audioVol]);

  // Export function
  const handleExport = (format: string) => {
    if (socket && crawledPages.length > 0) {
      socket.emit("exportData", format);
      addToast('info', 'Preparing export...');
    } else {
      addToast('warning', 'No data to export!');
    }
  };

  // View details of a specific page
  const viewPageDetails = (page: CrawledPage) => {
    setSelectedPage(page);
  };

  // Theme-based styling
  const isLightTheme = animState === 0 || animState === 3;
  const backgroundClass = isLightTheme
    ? "from-emerald-100 to-cyan-100"
    : animState === 2
    ? "background-pulse"
    : "bg-gray-950";

  return (
    <div
      className={`w-screen h-screen bg-gradient-to-br ${backgroundClass} pt-4 px-4 pb-16 overflow-y-auto ${
        isAttacking && (animState === 0 || animState === 3) ? "shake" : ""
      }`}
    >
      <audio ref={audioRef} src="/audio.mp3" />

      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map(toast => (
          <ToastNotification key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </div>

      <div className="max-w-3xl mx-auto space-y-6">
        {/* Title and Miku */}
        <div className="text-center">
          <h1 className="mb-2 text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-emerald-500 to-blue-500">
            Miku Miku Beam
          </h1>
          <p className={isLightTheme ? "text-gray-600" : "text-white"}>
          Because web crawling is cuter when Miku does it! 🌺
          </p>
        </div>

        <div
          className={`relative p-6 overflow-hidden rounded-lg shadow-xl ${
            isLightTheme ? "bg-white" : "bg-gray-950"
          }`}
        >
          {/* Miku GIF */}
          <div
            className="flex justify-center w-full h-48 mb-6"
            style={{
              backgroundImage: "url('/miku.gif')",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "center",
              backgroundSize: "cover",
              opacity: animState === 0 || animState === 3 ? 1 : 0,
              transition: "opacity 0.2s ease-in-out",
            }}
          ></div>

          {/* Crawler Config */}
          <div className="mb-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center">
                <input
                  type="text"
                  value={target}
                  onChange={handleTargetChange}
                  placeholder="Enter target URL"
                  className={`${
                    isLightTheme ? "" : "text-white bg-gray-800 border-gray-700"
                  } flex-1 px-4 py-2 border border-emerald-200 rounded-lg outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200`}
                  disabled={isAttacking}
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => (isAttacking ? stopAttack() : startAttack())}
                  className={`px-3 py-2 rounded-lg font-semibold text-white transition-all w-full ${
                    isAttacking
                      ? "bg-red-500 hover:bg-red-600"
                      : "bg-emerald-500 hover:bg-emerald-600"
                  } flex items-center justify-center gap-2 shadow-sm`}
                >
                  <Wand2 className="w-5 h-5" />
                  {isAttacking ? "Stop Beam" : "Start Miku Beam"}
                </button>
                <button
                  onClick={() => (isAttacking ? stopAttack() : startAttack(true))}
                  className={`px-3 py-2 rounded-lg font-semibold text-white transition-all ${
                    isAttacking
                      ? "bg-gray-500 hover:bg-red-600"
                      : "bg-cyan-500 hover:bg-cyan-600"
                  } flex items-center justify-center gap-2 shadow-sm`}
                >
                  <Zap className="w-5 h-5" />
                </button>
                <button
                  className="px-3 py-2 rounded-lg font-semibold text-white transition-all flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-900 shadow-sm"
                  onClick={() => setOpenedConfig(true)}
                  disabled={isAttacking}
                >
                  <Settings className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-4">
              <div>
                <label className={`block mb-1 text-sm font-medium ${isLightTheme ? "text-gray-700" : "text-white"}`}>
                  Crawl Method
                </label>
                <select
                  value={advancedOptions.crawlMethod}
                  onChange={(e) => setAdvancedOptions({...advancedOptions, crawlMethod: e.target.value})}
                  className={`${
                    isLightTheme ? "" : "text-white bg-gray-800 border-gray-700"
                  } w-full px-4 py-2 border border-emerald-200 rounded-lg outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200`}
                  disabled={isAttacking}
                >
                  <option value="links">Links Only</option>
                  <option value="content">Content + Links</option>
                  <option value="media">Media Files</option>
                  <option value="full">Full Crawl</option>
                </select>
              </div>
              <div>
                <label className={`block mb-1 text-sm font-medium ${isLightTheme ? "text-gray-700" : "text-white"}`}>
                  Max Depth
                </label>
                <input
                  type="number"
                  value={advancedOptions.crawlDepth}
                  onChange={(e) => setAdvancedOptions({...advancedOptions, crawlDepth: Number(e.target.value)})}
                  className={`${
                    isLightTheme ? "" : "text-white bg-gray-800 border-gray-700"
                  } w-full px-4 py-2 border border-emerald-200 rounded-lg outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200`}
                  disabled={isAttacking}
                  min="1"
                  max="5"
                />
              </div>
              <div>
                <label className={`block mb-1 text-sm font-medium ${isLightTheme ? "text-gray-700" : "text-white"}`}>
                  Max Pages
                </label>
                <input
                  type="number"
                  value={advancedOptions.maxPages}
                  onChange={(e) => setAdvancedOptions({...advancedOptions, maxPages: Number(e.target.value)})}
                  className={`${
                    isLightTheme ? "" : "text-white bg-gray-800 border-gray-700"
                  } w-full px-4 py-2 border border-emerald-200 rounded-lg outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200`}
                  disabled={isAttacking}
                  min="1"
                  max="200"
                />
              </div>
              <div>
                <label className={`block mb-1 text-sm font-medium ${isLightTheme ? "text-gray-700" : "text-white"}`}>
                  Delay (ms)
                </label>
                <input
                  type="number"
                  value={advancedOptions.crawlDelay}
                  onChange={(e) => setAdvancedOptions({...advancedOptions, crawlDelay: Number(e.target.value)})}
                  className={`${
                    isLightTheme ? "" : "text-white bg-gray-800 border-gray-700"
                  } w-full px-4 py-2 border border-emerald-200 rounded-lg outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200`}
                  disabled={isAttacking}
                  min="500"
                  max="5000"
                  step="100"
                />
              </div>
            </div>
          </div>

          {/* Stats Widgets */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            {/* Pages Scanned */}
            <div className="p-4 rounded-lg bg-gradient-to-br from-emerald-500/10 to-cyan-500/10">
              <div className="flex items-center gap-2 mb-2 text-emerald-600">
                <Bug className="w-4 h-4" />
                <span className="font-semibold">Pages Scanned</span>
              </div>
              <div className={`text-2xl font-bold ${isLightTheme ? "text-gray-800" : "text-white"}`}>
                {stats.pagesScanned.toLocaleString()}
              </div>
              
              {queueStats && isAttacking && (
                <div className="mt-1 text-xs text-gray-500">
                  {queueStats.pagesPerSecond.toFixed(2)} pages/sec • Queue: {queueStats.queueLength}
                </div>
              )}
            </div>
            
            {/* Links Found */}
            <div className="p-4 rounded-lg bg-gradient-to-br from-emerald-500/10 to-cyan-500/10">
              <div className="flex items-center gap-2 mb-2 text-emerald-600">
                <Link2 className="w-4 h-4" />
                <span className="font-semibold">Links Found</span>
              </div>
              <div className={`text-2xl font-bold ${isLightTheme ? "text-gray-800" : "text-white"}`}>
                {stats.linksFound.toLocaleString()}
              </div>
              
              {stats.successCount !== undefined && stats.failureCount !== undefined && (
                <div className="mt-1 text-xs text-gray-500">
                  {stats.successCount} success • {stats.failureCount} failed
                </div>
              )}
            </div>
            
            {/* Data (KB) */}
            <div className="p-4 rounded-lg bg-gradient-to-br from-emerald-500/10 to-cyan-500/10">
              <div className="flex items-center gap-2 mb-2 text-emerald-600">
                <ExternalLink className="w-4 h-4" />
                <span className="font-semibold">Data (KB)</span>
              </div>
              <div className={`text-2xl font-bold ${isLightTheme ? "text-gray-800" : "text-white"}`}>
                {stats.totalData.toLocaleString()}
              </div>
              
              {stats.mediaFiles !== undefined && (
                <div className="mt-1 text-xs text-gray-500">
                  {stats.mediaFiles} media files
                </div>
              )}
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-1">
              <span className={`text-sm ${isLightTheme ? "text-gray-600" : "text-gray-300"}`}>
                Crawl Progress
              </span>
              <span className={`text-sm ${isLightTheme ? "text-gray-600" : "text-gray-300"}`}>
                {progress.toFixed(0)}%
              </span>
            </div>
            <div className="h-4 overflow-hidden bg-gray-200 rounded-full">
              <div
                className="h-full transition-all duration-500 bg-gradient-to-r from-pink-500 to-blue-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex mb-6 space-x-2">
            <button
              className="flex items-center justify-center px-4 py-2 text-sm text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => setOpenExportDialog(true)}
              disabled={crawledPages.length === 0}
            >
              <Download className="w-4 h-4 mr-2" />
              Export Data
            </button>
            
            <button
              className="flex items-center justify-center px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700"
              onClick={() => setShowDetails(!showDetails)}
            >
              <ScrollText className="w-4 h-4 mr-2" />
              {showDetails ? "Hide Stats" : "Show Stats"}
            </button>
          </div>
          
          {/* Extended Stats */}
          {showDetails && (
            <StatsVisualizer stats={stats} />
          )}

          {/* Logs Section */}
          <div className="p-4 font-mono text-sm bg-gray-900 rounded-lg break-text">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-green-400">Crawler Logs</h3>
              <button
                className="px-2 py-1 text-xs text-white bg-gray-700 rounded hover:bg-gray-600"
                onClick={() => setLogs([])}
              >
                Clear
              </button>
            </div>
            <div className="text-green-400 max-h-40 overflow-y-auto" ref={logContainerRef}>
              {logs.length ? (
                logs.map((log, i) => (
                  <div key={i} className="py-1 border-b border-gray-800">
                    {"> "} {log}
                  </div>
                ))
              ) : (
                <div className="italic text-gray-500">{"> "} Waiting for Miku's crawler beam...</div>
              )}
            </div>
          </div>

          {/* Filter input */}
          <div className="flex items-center mt-4 mb-2">
            <div className="flex items-center flex-1 px-3 bg-gray-100 rounded-lg dark:bg-gray-800">
              <Filter className="w-4 h-4 mr-2 text-gray-400" />
              <input
                type="text"
                value={filterText}
                onChange={handleFilterChange}
                placeholder="Filter crawled pages..."
                className="w-full py-2 bg-transparent border-none focus:outline-none focus:ring-0 text-sm"
              />
              {filterText && (
                <button
                  onClick={() => {
                    setFilterText('');
                    setFilteredPages(crawledPages);
                    setIsFilterActive(false);
                  }}
                  className="p-1 text-gray-400 hover:text-gray-600"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="ml-2 text-sm text-gray-500">
              {isFilterActive 
                ? `${filteredPages.length}/${crawledPages.length}`
                : crawledPages.length} pages
            </div>
          </div>

          {/* Crawled Pages Section */}
          <div className="p-4 font-mono text-sm bg-gray-900 rounded-lg mt-2 max-h-96 overflow-y-auto break-text">
            {selectedPage ? (
              <CrawledPageDisplay 
                page={selectedPage} 
                onClose={() => setSelectedPage(null)}
              />
            ) : !crawledPages.length ? (
              <div className="italic text-gray-500">{"> "} No pages crawled yet...</div>
            ) : isFilterActive ? (
              filteredPages.length ? (
                filteredPages.map((page, i) => (
                  <div key={i} className="cursor-pointer" onClick={() => viewPageDetails(page)}>
                    <CrawledPageDisplay page={page} />
                  </div>
                ))
              ) : (
                <div className="italic text-gray-500">{"> "} No pages match your filter...</div>
              )
            ) : (
              crawledPages.map((page, i) => (
                <div key={i} className="cursor-pointer" onClick={() => viewPageDetails(page)}>
                  <CrawledPageDisplay page={page} />
                </div>
              ))
            )}
          </div>

          {/* Animation Overlay */}
          {isAttacking && (
            <div className="absolute inset-0 pointer-events-none">
              <div
                className={`
                  absolute inset-0 bg-gradient-to-r
                  ${
                    animState === 2
                      ? "from-pink-500/10 via-red-500/20 to-blue-500/10"
                      : "from-pink-500/10 to-blue-500/10"
                  }
                  animate-pulse
                `}
              />
              <div className="absolute top-0 -translate-x-1/2 left-1/2">
                <div className="w-2 h-2 bg-pink-500 rounded-full animate-bounce" />
              </div>
            </div>
          )}
        </div>

        {/* Configuration Dialog */}
        <ConfigurationView 
          isOpen={openedConfig} 
          onClose={() => setOpenedConfig(false)}
          options={advancedOptions}
          onOptionsChange={setAdvancedOptions}
          onSave={() => {
            addToast('success', 'Configuration saved');
          }}
        />
        
        {/* Export Dialog */}
        <ExportDialog
          isOpen={openExportDialog}
          onClose={() => setOpenExportDialog(false)}
          onExport={handleExport}
        />

        <div className="flex flex-col items-center">
          <span className="text-sm text-center text-gray-500">
            🕷️ v2.0 made with ❤️ by {""}
            <a href="https://github.com/renbkna" className="text-blue-500 hover:underline">
              renbkna
            </a>{" "}
            🕷️
          </span>
          <span>
            <input
              className="shadow-sm volume_bar focus:border-emerald-500"
              type="range"
              min="0"
              max="100"
              step="5"
              draggable="false"
              value={audioVol}
              onChange={(e) => setAudioVol(parseInt(e.target.value))}
              aria-label="Volume control"
            />
          </span>
        </div>
      </div>
    </div>
  );
}

export default App;