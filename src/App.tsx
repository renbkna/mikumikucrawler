import { Zap, Bug, Link2, ExternalLink, ScrollText, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

interface Stats {
  pagesScanned: number;
  linksFound: number;
  totalData: number;
}

interface StatsPayload extends Partial<Stats> {
  log?: string;
}

interface CrawledPage {
  url: string;
  content: string;
}

function ConfigurationView() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white shadow-lg">
      <p>Configuration Panel (to be implemented)</p>
    </div>
  );
}

  // Display a crawled page inside an iframe
function CrawledPageDisplay({ page }: { page: CrawledPage }) {
  return (
    <div className="py-2 border-b border-green-700">
      <div className="font-bold break-text mb-2">{page.url}</div>
      <iframe
        srcDoc={page.content}
        title={page.url}
        style={{ width: "100%", height: "400px", border: "none" }}
      />
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
  const [crawlMethod, setCrawlMethod] = useState<string>("links");
  const [crawlDepth, setCrawlDepth] = useState<number>(2);
  const [crawlDelay, setCrawlDelay] = useState<number>(1000);
  const [maxPages, setMaxPages] = useState<number>(50);

  const [stats, setStats] = useState<Stats>({
    pagesScanned: 0,
    linksFound: 0,
    totalData: 0,
  });

  const [audioVol, setAudioVol] = useState<number>(100);
  const [crawledPages, setCrawledPages] = useState<CrawledPage[]>([]);
  const [openedConfig, setOpenedConfig] = useState(false);
  const [currentTask, setCurrentTask] = useState<NodeJS.Timeout | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Connect to backend using the environment variable (VITE_BACKEND_URL)
  useEffect(() => {
    const socketEndpoint = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";
    const newSocket = io(socketEndpoint, { transports: ["websocket"] });
    setSocket(newSocket);

    newSocket.on("stats", (data: StatsPayload) => {
      // Merge new stats
      setStats((old) => ({
        pagesScanned: data.pagesScanned ?? old.pagesScanned,
        linksFound: data.linksFound ?? old.linksFound,
        totalData: data.totalData ?? old.totalData,
      }));
      if (data.log) {
        addLog(data.log);
      }
      setProgress((prev) => (prev + 10) % 100);
    });

    newSocket.on("pageContent", (data: CrawledPage) => {
      setCrawledPages((prev) => [data, ...prev]);
    });

    newSocket.on("attackEnd", () => {
      setIsAttacking(false);
      addLog("🛑 Crawl ended.");
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
    });

    return () => {
      newSocket.close();
    };
  }, []);

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

  useEffect(() => {
    if (!isAttacking) {
      if (currentTask) {
        clearTimeout(currentTask);
      }
    }
  }, [isAttacking, currentTask]);

  const addLog = (msg: string) => {
    setLogs((prev) => [msg, ...prev].slice(0, 12));
  };

  const startAttack = (isQuick = false) => {
    if (!target.trim()) {
      alert("Please enter a target!");
      return;
    }
    if (!socket) {
      alert("Socket not connected!");
      return;
    }

    // Reset stats and logs for a new crawl session
    setStats({ pagesScanned: 0, linksFound: 0, totalData: 0 });
    setCrawledPages([]);
    addLog("🕷️ Preparing miku beam...");

    if (audioRef.current) {
      audioRef.current.currentTime = isQuick ? 9.5 : 0;
      audioRef.current.volume = audioVol / 100;
      audioRef.current.play().catch(console.error);
    }

    if (!isQuick) setAnimState(1);

    const timeout = setTimeout(() => {
      setAnimState(3);
      socket.emit("startAttack", {
        target,
        crawlMethod,
        crawlDepth,
        crawlDelay,
        maxPages,
      });
    }, isQuick ? 700 : 10250);
    setCurrentTask(timeout);

    setIsAttacking(true);
    addLog(`🌐 Starting crawl on ${target}`);
    addLog("📡 Scanning for links and data...");
  };

  const stopAttack = () => {
    if (socket) {
      socket.emit("stopAttack");
      setIsAttacking(false);
      addLog("🛑 Stopped crawler beam.");
    }
  };

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = audioVol / 100;
    }
  }, [audioVol]);

  const isLightTheme = animState === 0 || animState === 3;
  const backgroundClass = isLightTheme
    ? "from-emerald-100 to-cyan-100"
    : animState === 2
    ? "background-pulse"
    : "bg-gray-950";

  return (
    <div
      className={`w-screen h-screen bg-gradient-to-br ${backgroundClass} p-8 overflow-y-auto ${
        isAttacking && (animState === 0 || animState === 3) ? "shake" : ""
      }`}
    >
      <audio ref={audioRef} src="/audio.mp3" />

      <div className="max-w-2xl mx-auto space-y-8">
        {/* Title and Miku */}
        <div className="text-center">
          <h1 className="mb-2 text-4xl font-bold text-emerald-500">
            Miku Miku Beam
          </h1>
          <p className={isLightTheme ? "text-gray-600" : "text-white"}>
            Because web crawling is cuter when Miku does it! 🕷️✨
          </p>
        </div>

        <div
          className={`relative p-6 overflow-hidden rounded-lg shadow-xl ${
            isLightTheme ? "bg-white" : "bg-gray-950"
          }`}
        >
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
            <div className="grid grid-cols-2 gap-4">
              <input
                type="text"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="Enter target URL"
                className={`${
                  isLightTheme ? "" : "text-white"
                } px-4 py-2 border border-emerald-200 rounded-lg outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200`}
                disabled={isAttacking}
              />
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
                >
                  <ScrollText className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-4">
              <div>
                <label className={`block mb-1 text-sm font-medium ${isLightTheme ? "text-gray-700" : "text-white"}`}>
                  Crawl Method
                </label>
                <select
                  value={crawlMethod}
                  onChange={(e) => setCrawlMethod(e.target.value)}
                  className={`${
                    isLightTheme ? "" : "text-gray-900"
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
                  value={crawlDepth}
                  onChange={(e) => setCrawlDepth(Number(e.target.value))}
                  className={`${
                    isLightTheme ? "" : "text-white"
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
                  value={maxPages}
                  onChange={(e) => setMaxPages(Number(e.target.value))}
                  className={`${
                    isLightTheme ? "" : "text-white"
                  } w-full px-4 py-2 border border-emerald-200 rounded-lg outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200`}
                  disabled={isAttacking}
                  min="1"
                  max="100"
                />
              </div>
              <div>
                <label className={`block mb-1 text-sm font-medium ${isLightTheme ? "text-gray-700" : "text-white"}`}>
                  Delay (ms)
                </label>
                <input
                  type="number"
                  value={crawlDelay}
                  onChange={(e) => setCrawlDelay(Number(e.target.value))}
                  className={`${
                    isLightTheme ? "" : "text-white"
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
            </div>
          </div>

          {/* Progress Bar */}
          <div className="h-4 mb-6 overflow-hidden bg-gray-200 rounded-full">
            <div
              className="h-full transition-all duration-500 bg-gradient-to-r from-pink-500 to-blue-500"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Logs Section */}
          <div className="p-4 font-mono text-sm bg-gray-900 rounded-lg break-text">
            <div className="text-green-400">
              {logs.length ? (
                logs.map((log, i) => (
                  <div key={i} className="py-1">
                    {"> "} {log}
                  </div>
                ))
              ) : (
                <div className="italic text-gray-500">{"> "} Waiting for Miku's crawler beam...</div>
              )}
            </div>
          </div>

          {/* Crawled Pages Section */}
          <div className="p-4 font-mono text-sm bg-gray-900 rounded-lg mt-4 max-h-96 overflow-y-auto break-text">
            <div className="text-green-400">
              {!crawledPages.length ? (
                <div className="italic text-gray-500">{"> "} No pages crawled yet...</div>
              ) : (
                crawledPages.map((page, i) => <CrawledPageDisplay key={i} page={page} />)
              )}
            </div>
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

        {openedConfig && <ConfigurationView />}

        <div className="flex flex-col items-center">
          <span className="text-sm text-center text-gray-500">
            🕷️ v1.0 made by{" "}
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
            />
          </span>
        </div>
      </div>
    </div>
  );
}

export default App;
