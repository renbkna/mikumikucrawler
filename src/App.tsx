import { Heart, Music } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  ActionButtons,
  ConfigurationView,
  CrawledPagesSection,
  CrawlerForm,
  ExportDialog,
  LogsSection,
  ProgressBar,
  StatsGrid,
  StatsVisualizer,
  ToastNotification,
} from './components';
import { MikuBanner } from './components/MikuBanner';
import { TheatreOverlay } from './components/TheatreOverlay';
import {
  CrawledPage,
  CrawlOptions,
  QueueStats,
  Stats,
  StatsPayload,
  Toast,
} from './types';

const MAX_PAGE_BUFFER = 200;

type PageAction =
  | { type: 'add'; page: CrawledPage }
  | { type: 'reset' };

function pagesReducer(state: CrawledPage[], action: PageAction): CrawledPage[] {
  switch (action.type) {
    case 'add': {
      const next = [action.page, ...state];
      return next.length > MAX_PAGE_BUFFER ? next.slice(0, MAX_PAGE_BUFFER) : next;
    }
    case 'reset':
      return [];
    default:
      return state;
  }
}

function App() {
  const [isAttacking, setIsAttacking] = useState(false);
  const [theatreStatus, setTheatreStatus] = useState<'idle' | 'blackout' | 'counting' | 'beam' | 'live'>('idle');

  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<number>(0);

  const [target, setTarget] = useState<string>('');
  const [advancedOptions, setAdvancedOptions] = useState<CrawlOptions>({
    target: '',
    crawlMethod: 'links',
    crawlDepth: 2,
    crawlDelay: 1000,
    maxPages: 50,
    maxConcurrentRequests: 5,
    retryLimit: 3,
    dynamic: true,
    respectRobots: true,
    contentOnly: false,
    saveMedia: false,
  });

  const [audioVol, setAudioVol] = useState<number>(100);
  const [crawledPages, dispatchPages] = useReducer(pagesReducer, [] as CrawledPage[]);
  const [selectedPage, setSelectedPage] = useState<CrawledPage | null>(null);
  const [openedConfig, setOpenedConfig] = useState(false);
  const [openExportDialog, setOpenExportDialog] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const maxPagesRef = useRef(advancedOptions.maxPages);
  const fallbackToastShownRef = useRef(false);

  const [stats, setStats] = useState<Stats>({
    pagesScanned: 0,
    linksFound: 0,
    totalData: 0,
    mediaFiles: 0,
    successCount: 0,
    failureCount: 0,
    skippedCount: 0,
  });

  const addToast = useCallback(
    (
      type: 'success' | 'error' | 'info' | 'warning',
      message: string,
      timeout = 3000
    ) => {
      const id = Date.now();
      setToasts((prevToasts) => [
        ...prevToasts,
        { id, type, message, timeout },
      ]);
    },
    []
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prevToasts) => prevToasts.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    maxPagesRef.current = advancedOptions.maxPages;
  }, [advancedOptions.maxPages]);

  const addLog = useCallback(
    (msg: string) => {
      setLogs((prev) => {
        const newLogs = [msg, ...prev].slice(0, 30);
        return newLogs;
      });

      const lowered = msg.toLowerCase();
      if (
        lowered.includes('falling back to static crawling') &&
        !fallbackToastShownRef.current
      ) {
        addToast(
          'warning',
          'Tip: Try disabling JavaScript crawling in settings for better performance',
          5000
        );
        fallbackToastShownRef.current = true;
      }

      if (logContainerRef.current) {
        setTimeout(() => {
          if (logContainerRef.current) {
            logContainerRef.current.scrollTop = 0;
          }
        }, 10);
      }
    },
    [addToast]
  );

  useEffect(() => {
    const socketEndpoint =
      import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
    console.log(`Connecting to backend at ${socketEndpoint}`);

    let isCancelled = false;
    let cleanupSocket: (() => void) | null = null;

    const connectTimer = setTimeout(() => {
      if (isCancelled) return;

      try {
        const newSocket = io(socketEndpoint, {
          transports: ['websocket', 'polling'],
          reconnectionAttempts: 10,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
          timeout: 20000,
          forceNew: true,
        });

        const handleConnect = () => {
          console.log('Connected to backend');
          addToast('success', 'Connected to crawler backend');
          setSocket(newSocket);
        };

        const handleConnectError = (err: Error) => {
          console.error('Connection error:', err);
          addToast('error', `Connection error: ${err.message}`);
        };

        const handleStats = (data: StatsPayload) => {
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
            successRate: data.successRate ?? old.successRate,
          }));

          if (data.log) {
            addLog(data.log);
          }

          setProgress((prev) => {
            const adjustedTarget = Math.max(maxPagesRef.current * 0.8, 1);
            const newProgress = Math.min(
              ((data.pagesScanned || 0) / adjustedTarget) * 100,
              99
            );
            return Math.max(prev, newProgress);
          });
        };

        const handleQueueStats = (data: QueueStats) => {
          const sanitizedRate = Number.isFinite(data.pagesPerSecond)
            ? data.pagesPerSecond
            : 0;
          setQueueStats({ ...data, pagesPerSecond: sanitizedRate });
        };

        const handlePageContent = (data: CrawledPage) => {
          dispatchPages({ type: 'add', page: data });
        };

        const handleExportResult = (data: { data: string; format: string }) => {
          const blob = new Blob([data.data], {
            type: data.format === 'json' ? 'application/json' : 'text/csv',
          });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `miku-crawler-export.${data.format}`;
          document.body.appendChild(anchor);
          anchor.click();

          setTimeout(() => {
            document.body.removeChild(anchor);
            URL.revokeObjectURL(url);
          }, 100);

          addToast(
            'success',
            `Data exported successfully as ${data.format.toUpperCase()}`
          );
        };

        const handleErrorEvent = (error: { message?: string } | Error) => {
          const message = error instanceof Error ? error.message : error?.message;
          addToast('error', message || 'An unknown crawler error occurred');
        };

        const handleAttackEnd = (finalStats: Stats) => {
          setIsAttacking(false);
          addLog('Crawl ended.');
          setStats(finalStats);
          setProgress(100);

          addToast(
            'success',
            `Crawl completed! Scanned ${finalStats.pagesScanned} pages`,
            5000
          );
        };

        const handleDisconnect = () => {
          console.log('Disconnected from backend');
          addToast('warning', 'Disconnected from crawler backend');
          setSocket(null);
        };

        newSocket.on('connect', handleConnect);
        newSocket.on('connect_error', handleConnectError);
        newSocket.on('stats', handleStats);
        newSocket.on('queueStats', handleQueueStats);
        newSocket.on('pageContent', handlePageContent);
        newSocket.on('exportResult', handleExportResult);
        newSocket.on('crawlError', handleErrorEvent);
        newSocket.on('error', handleErrorEvent);
        newSocket.on('attackEnd', handleAttackEnd);
        newSocket.on('disconnect', handleDisconnect);

        socketRef.current = newSocket;

        cleanupSocket = () => {
          newSocket.off('connect', handleConnect);
          newSocket.off('connect_error', handleConnectError);
          newSocket.off('stats', handleStats);
          newSocket.off('queueStats', handleQueueStats);
          newSocket.off('pageContent', handlePageContent);
          newSocket.off('exportResult', handleExportResult);
          newSocket.off('crawlError', handleErrorEvent);
          newSocket.off('error', handleErrorEvent);
          newSocket.off('attackEnd', handleAttackEnd);
          newSocket.off('disconnect', handleDisconnect);
          newSocket.close();
          if (socketRef.current === newSocket) {
            socketRef.current = null;
          }
          setSocket((prev) => (prev === newSocket ? null : prev));
        };
      } catch (error) {
        console.error('Socket initialization error:', error);
        addToast(
          'error',
          `Failed to connect to backend: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        );
      }
    }, 500);

    return () => {
      isCancelled = true;
      clearTimeout(connectTimer);
      if (cleanupSocket) {
        cleanupSocket();
        cleanupSocket = null;
      } else if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      setSocket(null);
    };
  }, [addLog, addToast]);

  const handleTargetChange = (newTarget: string) => {
    setTarget(newTarget);
    setAdvancedOptions((prev) => ({
      ...prev,
      target: newTarget,
    }));
  };

  const filterPages = (
    pages: CrawledPage[],
    filterString: string
  ): CrawledPage[] => {
    if (!filterString.trim()) return pages;

    const lowerFilter = filterString.toLowerCase();
    return pages.filter(
      (page) =>
        page.url.toLowerCase().includes(lowerFilter) ||
        (page.title && page.title.toLowerCase().includes(lowerFilter)) ||
        (page.description &&
          page.description.toLowerCase().includes(lowerFilter))
    );
  };

  const filteredPages = useMemo(
    () => filterPages(crawledPages, filterText),
    [crawledPages, filterText]
  );
  const isFilterActive = filterText.trim().length > 0;
  const displayedPages = isFilterActive ? filteredPages : crawledPages;
  const clearFilter = useCallback(() => setFilterText(''), []);

  const handleFilterChange = (filter: string) => {
    setFilterText(filter);
  };

  const validateTarget = (url: string): boolean => {
    try {
      if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
        setTarget(url);
        setAdvancedOptions((prev) => ({ ...prev, target: url }));
      }
      new URL(url);
      return true;
    } catch {
      addToast('error', 'Please enter a valid URL');
      return false;
    }
  };

  const startAttack = (isQuick = false) => {
    fallbackToastShownRef.current = false;
    if (!target.trim()) {
      addToast('error', 'Please enter a target URL!');
      return;
    }

    if (!validateTarget(target)) {
      return;
    }

    if (!socket) {
      addToast(
        'error',
        'Socket not connected! Please wait or refresh the page.'
      );
      return;
    }

    setStats({
      pagesScanned: 0,
      linksFound: 0,
      totalData: 0,
      mediaFiles: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0,
    });
    dispatchPages({ type: 'reset' });
    setFilterText('');
    setSelectedPage(null);
    setProgress(0);
    addLog('Initiating Miku Beam Sequence...');

    setIsAttacking(true);

    if (isQuick) {
        setTheatreStatus('live');
        addToast('info', '⚡ Lightning Strike! Skipping animation...');
    } else {
        setTheatreStatus('blackout');
    }

    const optionsToSend = {
      ...advancedOptions,
      target: target,
    };
    socket.emit('startAttack', optionsToSend);
  };

  const stopAttack = () => {
    if (socket) {
      socket.emit('stopAttack');
      addLog('Stopped crawler beam.');
      addToast('info', 'Crawler stopped');
    }
    setIsAttacking(false);
    setTheatreStatus('idle');
    setProgress(0);
  };

  const handleExport = (format: string) => {
    if (socket && crawledPages.length > 0) {
      socket.emit('exportData', format);
      addToast('info', 'Preparing export...');
    } else {
      addToast('warning', 'No data to export!');
    }
  };

  const viewPageDetails = (page: CrawledPage) => {
    setSelectedPage(page);
  };

  const handleBeamStart = useCallback(() => {
    setTheatreStatus('beam');
  }, []);

  const handleTheatreComplete = useCallback(() => {
    setTheatreStatus('live');
  }, []);

  const isUIHidden = theatreStatus === 'blackout' || theatreStatus === 'counting';
  const isModalOpen = openedConfig || openExportDialog;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-miku-bg text-miku-text font-sans transition-colors duration-500">

      {/* THEATRE OVERLAY */}
      <TheatreOverlay
        status={theatreStatus}
        onBeamStart={handleBeamStart}
        onComplete={handleTheatreComplete}
      />

      {/* MAIN UI LAYER */}
      <div
        className={`relative w-full h-full pt-4 px-4 pb-16 transition-all duration-1000 ${
          isUIHidden ? 'opacity-0 scale-95 blur-xl pointer-events-none' : 'opacity-100 scale-100 blur-0'
        } ${isModalOpen ? 'overflow-hidden' : 'overflow-y-auto'}`}
      >
        {/* Floating Decorations */}
        <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
             <div className="absolute top-10 left-10 w-32 h-32 bg-miku-teal/10 rounded-full blur-3xl animate-float" />
             <div className="absolute bottom-20 right-20 w-40 h-40 bg-miku-pink/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '1s' }} />
        </div>

        {/* Toast Notifications */}
        <div className="fixed top-4 right-4 z-50 space-y-2">
            {toasts.map((toast) => (
            <ToastNotification
                key={toast.id}
                toast={toast}
                onDismiss={dismissToast}
            />
            ))}
        </div>

        <div className="relative z-10 max-w-7xl mx-auto space-y-8">
            {/* Header - Cute Style */}
            <div className="flex items-center justify-center py-8">
                <div className="glass-panel px-8 py-4 flex items-center gap-4 animate-bounce-slow">
                    <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center shadow-lg border-2 border-miku-teal/20">
                        <Music className="w-6 h-6 text-miku-teal fill-miku-teal/20" />
                    </div>
                    <div className="text-center">
                        <h1 className="text-3xl font-black tracking-tight text-miku-teal drop-shadow-sm">
                            Miku Miku Crawler
                        </h1>
                        <p className="text-xs font-bold text-miku-pink tracking-widest">Because web crawling is cuter when Miku does it! 🌸</p>
                    </div>
                    <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center shadow-lg border-2 border-miku-pink/20">
                        <Heart className="w-6 h-6 text-miku-pink fill-miku-pink/20" />
                    </div>
                </div>
            </div>

            {/* Main Control Panel */}
            <div className="glass-panel p-8 relative overflow-hidden group hover:shadow-xl transition-all duration-500">
                {/* Miku Banner - Integrated here */}
                <MikuBanner active={theatreStatus === 'beam' || isAttacking} />

                <CrawlerForm
                    target={target}
                    setTarget={handleTargetChange}
                    advancedOptions={advancedOptions}
                    setAdvancedOptions={setAdvancedOptions}
                    isAttacking={isAttacking}
                    startAttack={startAttack}
                    stopAttack={stopAttack}
                    setOpenedConfig={setOpenedConfig}
                    isLightTheme={true}
                />
            </div>

            {/* Stats & Progress */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 glass-panel p-6">
                    <StatsGrid
                        stats={stats}
                        queueStats={queueStats}
                        isAttacking={isAttacking}
                        isLightTheme={true}
                    />
                </div>
                <div className="glass-panel p-6 flex flex-col justify-center">
                    <ProgressBar progress={progress} isLightTheme={true} />
                </div>
            </div>

            {/* Action Buttons */}
            <ActionButtons
                crawledPages={crawledPages}
                setOpenExportDialog={setOpenExportDialog}
                showDetails={showDetails}
                setShowDetails={setShowDetails}
            />

            {/* Extended Stats */}
            {showDetails && <StatsVisualizer stats={stats} />}

            {/* Logs & Results */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="glass-panel p-6 h-[600px] flex flex-col">
                    <div className="flex items-center justify-between mb-4 border-b border-miku-teal/20 pb-2">
                        <h3 className="text-lg font-bold text-miku-teal flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-miku-teal animate-pulse" />
                            System Logs
                        </h3>
                    </div>
                    <LogsSection
                        logs={logs}
                        setLogs={setLogs}
                        logContainerRef={logContainerRef as React.RefObject<HTMLDivElement>}
                    />
                </div>
                <div className="glass-panel p-6 h-[600px] flex flex-col">
                    <div className="flex items-center justify-between mb-4 border-b border-miku-pink/20 pb-2">
                        <h3 className="text-lg font-bold text-miku-pink flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-miku-pink animate-pulse" />
                            Captured Data
                        </h3>
                        <span className="text-xs font-bold text-miku-text/50 bg-white px-2 py-1 rounded-full">
                            {crawledPages.length} items
                        </span>
                    </div>
                    <CrawledPagesSection
                        crawledPages={crawledPages}
                        displayedPages={displayedPages}
                        filterText={filterText}
                        onFilterChange={handleFilterChange}
                        onClearFilter={clearFilter}
                        isFilterActive={isFilterActive}
                        selectedPage={selectedPage}
                        setSelectedPage={setSelectedPage}
                        viewPageDetails={viewPageDetails}
                        pageLimit={MAX_PAGE_BUFFER}
                    />
                </div>
            </div>
        </div>

        {/* Footer */}
        <div className="mt-12 pb-8 text-center">
            <div className="inline-block glass-panel px-8 py-4 rounded-full">
                <div className="flex items-center gap-4">
                    <span className="text-miku-pink animate-bounce">♥</span>
                    <span className="text-sm text-miku-text font-bold">
                        Miku Miku Crawler <span className="text-miku-teal">v2.0</span>
                    </span>
                    <span className="text-miku-teal animate-bounce delay-100">♥</span>

                    <div className="w-px h-4 bg-miku-text/20 mx-2" />

                    <div className="flex items-center gap-2">
                        <span className="text-xs text-miku-teal font-bold">VOL</span>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={audioVol}
                            onChange={(e) => setAudioVol(parseInt(e.target.value))}
                            className="w-24 h-1 bg-miku-bg rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-miku-teal [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-md"
                        />
                    </div>
                </div>
            </div>
        </div>
      </div>

      {/* Configuration Dialog */}
      <ConfigurationView
        isOpen={openedConfig}
        onClose={() => setOpenedConfig(false)}
        options={advancedOptions}
        onOptionsChange={setAdvancedOptions}
        onSave={() => {
          addToast('success', 'Configuration saved! ✨');
        }}
      />

      {/* Export Dialog */}
      <ExportDialog
        isOpen={openExportDialog}
        onClose={() => setOpenExportDialog(false)}
        onExport={handleExport}
      />
    </div>
  );
}

export default App;
