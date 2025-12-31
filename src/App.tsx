import { Heart, Music } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActionButtons,
	ConfigurationView,
	CrawledPagesSection,
	CrawlerForm,
	ExportDialog,
	HeartIcon,
	LogsSection,
	NoteIcon,
	ProgressBar,
	SparkleIcon,
	StatsGrid,
	StatsVisualizer,
	ToastNotification,
} from "./components";
import { MikuBanner } from "./components/MikuBanner";
import { TheatreOverlay } from "./components/TheatreOverlay";
import { PROGRESS_CONFIG, TOAST_DEFAULTS, UI_LIMITS } from "./constants";
import { useSocket, useToast } from "./hooks";
import { useCrawlState } from "./hooks/useCrawlState";
import type { CrawledPage, QueueStats, Stats } from "./types";

function App() {
	const [isAttacking, setIsAttacking] = useState(false);
	const [theatreStatus, setTheatreStatus] = useState<
		"idle" | "blackout" | "counting" | "beam" | "live"
	>("idle");
	const [openedConfig, setOpenedConfig] = useState(false);
	const [openExportDialog, setOpenExportDialog] = useState(false);
	const [showDetails, setShowDetails] = useState(false);
	const [audioVol, setAudioVol] = useState(100);

	const { toasts, addToast, dismissToast } = useToast();

	const {
		target,
		setTarget,
		crawlOptions,
		setCrawlOptions,
		handleTargetChange,
		stats,
		setStats,
		queueStats,
		setQueueStats,
		resetStats,
		crawledPages,
		addPage,
		resetPages,
		progress,
		setProgress,
		logs,
		setLogs,
		filterText,
		setFilterText,
		displayedPages,
		clearFilter,
	} = useCrawlState();

	const logContainerRef = useRef<HTMLDivElement>(null);
	const maxPagesRef = useRef(crawlOptions.maxPages);
	const fallbackToastShownRef = useRef(false);

	useEffect(() => {
		maxPagesRef.current = crawlOptions.maxPages;
	}, [crawlOptions.maxPages]);

	const addLog = useCallback(
		(msg: string) => {
			setLogs((prev) => [msg, ...prev].slice(0, UI_LIMITS.MAX_LOGS));

			const lowered = msg.toLowerCase();
			if (
				lowered.includes("falling back to static crawling") &&
				!fallbackToastShownRef.current
			) {
				addToast(
					"warning",
					"Tip: Try disabling JavaScript crawling in settings for better performance",
					TOAST_DEFAULTS.LONG_TIMEOUT,
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
		[addToast, setLogs],
	);

	const handleStatsUpdate = useCallback(
		(newStats: Stats, log?: string) => {
			setStats((old) => ({
				pagesScanned: newStats.pagesScanned ?? old.pagesScanned,
				linksFound: newStats.linksFound ?? old.linksFound,
				totalData: newStats.totalData ?? old.totalData,
				mediaFiles: newStats.mediaFiles ?? old.mediaFiles,
				successCount: newStats.successCount ?? old.successCount,
				failureCount: newStats.failureCount ?? old.failureCount,
				skippedCount: newStats.skippedCount ?? old.skippedCount,
				elapsedTime: newStats.elapsedTime ?? old.elapsedTime,
				pagesPerSecond: newStats.pagesPerSecond ?? old.pagesPerSecond,
				successRate: newStats.successRate ?? old.successRate,
			}));

			if (log) {
				addLog(log);
			}

			setProgress((prev) => {
				const adjustedTarget = Math.max(
					maxPagesRef.current * PROGRESS_CONFIG.TARGET_MULTIPLIER,
					1,
				);
				const newProgress = Math.min(
					((newStats.pagesScanned || 0) / adjustedTarget) * 100,
					PROGRESS_CONFIG.MAX_PROGRESS_BEFORE_COMPLETE,
				);
				return Math.max(prev, newProgress);
			});
		},
		[addLog, setStats, setProgress],
	);

	const handleQueueStats = useCallback(
		(data: QueueStats) => {
			setQueueStats(data);
		},
		[setQueueStats],
	);

	const handlePageContent = useCallback(
		(page: CrawledPage) => {
			addPage(page);
		},
		[addPage],
	);

	const handleExportResult = useCallback(
		(data: { data: string; format: string }) => {
			const blob = new Blob([data.data], {
				type: data.format === "json" ? "application/json" : "text/csv",
			});
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `miku-crawler-export.${data.format}`;
			document.body.appendChild(anchor);
			anchor.click();

			setTimeout(() => {
				anchor.remove();
				URL.revokeObjectURL(url);
			}, 100);

			addToast(
				"success",
				`Data exported successfully as ${data.format.toUpperCase()}`,
			);
		},
		[addToast],
	);

	const handleError = useCallback(
		(message: string) => {
			addToast("error", message);
		},
		[addToast],
	);

	const handleAttackEnd = useCallback(
		(finalStats: Stats) => {
			setIsAttacking(false);
			setTheatreStatus("idle");
			addLog("Crawl ended.");
			setStats(finalStats);
			setProgress(100);
			addToast(
				"success",
				`Crawl completed! Scanned ${finalStats.pagesScanned} pages`,
				TOAST_DEFAULTS.LONG_TIMEOUT,
			);
		},
		[addLog, addToast, setStats, setProgress],
	);

	const socketHandlers = useMemo(
		() => ({
			onStatsUpdate: handleStatsUpdate,
			onQueueStats: handleQueueStats,
			onPageContent: handlePageContent,
			onExportResult: handleExportResult,
			onError: handleError,
			onAttackEnd: handleAttackEnd,
			addToast,
		}),
		[
			handleStatsUpdate,
			handleQueueStats,
			handlePageContent,
			handleExportResult,
			handleError,
			handleAttackEnd,
			addToast,
		],
	);

	const { socket, connectionState, emit } = useSocket(socketHandlers);

	const normalizeAndValidateUrl = useCallback(
		(url: string): { url: string } | { error: string } => {
			try {
				let normalizedUrl = url;
				if (!/^https?:\/\//i.test(url)) {
					normalizedUrl = `http://${url}`;
				}
				new URL(normalizedUrl);
				return { url: normalizedUrl };
			} catch {
				return { error: "Please enter a valid URL" };
			}
		},
		[],
	);

	const startAttack = useCallback(
		(isQuick = false) => {
			fallbackToastShownRef.current = false;
			if (!target.trim()) {
				addToast("error", "Please enter a target URL!");
				return;
			}

			const validationResult = normalizeAndValidateUrl(target);
			if ("error" in validationResult) {
				addToast("error", validationResult.error);
				return;
			}

			const normalizedTarget = validationResult.url;

			if (normalizedTarget !== target) {
				setTarget(normalizedTarget);
				setCrawlOptions((prev) => ({ ...prev, target: normalizedTarget }));
			}

			if (!socket) {
				addToast(
					"error",
					"Socket not connected! Please wait or refresh the page.",
				);
				return;
			}

			resetStats();
			resetPages();
			setFilterText("");
			setProgress(0);
			addLog("Initiating Miku Beam Sequence...");
			setIsAttacking(true);

			if (isQuick) {
				setTheatreStatus("live");
				addToast("info", "⚡ Lightning Strike! Skipping animation...");
			} else {
				setTheatreStatus("blackout");
			}

			emit("startAttack", { ...crawlOptions, target: normalizedTarget });
		},
		[
			target,
			socket,
			normalizeAndValidateUrl,
			addLog,
			addToast,
			emit,
			crawlOptions,
			resetStats,
			resetPages,
			setFilterText,
			setProgress,
			setTarget,
			setCrawlOptions,
		],
	);

	const stopAttack = useCallback(() => {
		emit("stopAttack");
		addLog("Stopped crawler beam.");
		addToast("info", "Crawler stopped");
		setIsAttacking(false);
		setTheatreStatus("idle");
		setProgress(0);
	}, [emit, addLog, addToast, setProgress]);

	const handleExport = useCallback(
		(format: string) => {
			if (socket && crawledPages.length > 0) {
				emit("exportData", format);
				addToast("info", "Preparing export...");
			} else {
				addToast("warning", "No data to export!");
			}
		},
		[socket, crawledPages.length, emit, addToast],
	);

	const handleBeamStart = useCallback(() => {
		setTheatreStatus("beam");
	}, []);

	const handleTheatreComplete = useCallback(() => {
		setTheatreStatus("live");
	}, []);

	const isUIHidden =
		theatreStatus === "blackout" || theatreStatus === "counting";
	const isModalOpen = openedConfig || openExportDialog;

	return (
		<div className="relative w-screen h-screen overflow-hidden text-miku-text font-sans">
			<TheatreOverlay
				status={theatreStatus}
				onBeamStart={handleBeamStart}
				onComplete={handleTheatreComplete}
				volume={audioVol}
			/>

			<div
				className={`relative w-full h-full pt-4 px-4 pb-16 transition-all duration-1000 ${
					isUIHidden
						? "opacity-0 scale-95 blur-xl pointer-events-none"
						: "opacity-100 scale-100 blur-0"
				} ${isModalOpen ? "overflow-hidden" : "overflow-y-auto"}`}
			>
				<div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
					<div className="absolute top-10 left-10 w-32 h-32 bg-miku-teal/10 rounded-full blur-3xl animate-float" />
					<div
						className="absolute bottom-20 right-20 w-40 h-40 bg-miku-pink/10 rounded-full blur-3xl animate-float"
						style={{ animationDelay: "1s" }}
					/>
				</div>

				<div className="fixed top-4 right-4 z-50 space-y-2">
					{toasts.map((toast) => (
						<ToastNotification
							key={toast.id}
							toast={toast}
							onDismiss={dismissToast}
						/>
					))}
				</div>

				<main className="relative z-10 max-w-7xl mx-auto space-y-8">
					<header className="flex items-center justify-center py-6">
						<div className="glass-panel px-6 py-4 inline-flex items-center gap-3">
							<div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-miku-teal to-miku-pink flex items-center justify-center shadow-md">
								<Music className="w-5 h-5 text-white" />
							</div>

							<div>
								<h1 className="text-2xl font-black tracking-tight flex items-center gap-0.5">
									<span className="text-miku-teal-dark">Miku</span>
									<HeartIcon className="text-miku-pink mx-0.5" size={16} />
									<span className="text-miku-pink-dark">Miku</span>
									<HeartIcon className="text-miku-accent mx-0.5" size={16} />
									<span className="text-miku-accent">Crawler</span>
								</h1>
								<p className="text-xs text-miku-text/50 font-medium text-center">
									web crawling, but cuter
								</p>
							</div>

							<div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-miku-pink to-miku-accent flex items-center justify-center shadow-md">
								<Heart
									className="w-5 h-5 text-white animate-heart-beat"
									fill="white"
								/>
							</div>
						</div>
					</header>

					<section
						aria-label="Crawler Control"
						className="glass-panel p-8 relative overflow-hidden group hover:shadow-xl transition-all duration-500"
					>
						<MikuBanner active={theatreStatus === "beam" || isAttacking} />

						<CrawlerForm
							target={target}
							setTarget={handleTargetChange}
							crawlOptions={crawlOptions}
							isAttacking={isAttacking}
							startAttack={startAttack}
							stopAttack={stopAttack}
							setOpenedConfig={setOpenedConfig}
							connectionState={connectionState}
						/>
					</section>

					<section
						aria-label="Statistics"
						className="grid grid-cols-1 lg:grid-cols-3 gap-6"
					>
						<div className="lg:col-span-2 glass-panel p-6">
							<StatsGrid
								stats={stats}
								queueStats={queueStats}
								isAttacking={isAttacking}
							/>
						</div>
						<div className="glass-panel p-6 flex flex-col justify-center">
							<ProgressBar progress={progress} />
						</div>
					</section>

					<ActionButtons
						crawledPages={crawledPages}
						setOpenExportDialog={setOpenExportDialog}
						showDetails={showDetails}
						setShowDetails={setShowDetails}
					/>

					{showDetails && <StatsVisualizer stats={stats} />}

					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
						<section
							aria-labelledby="logs-heading"
							className="glass-panel p-6 h-[600px] flex flex-col"
						>
							<div className="flex items-center justify-between mb-4 border-b-2 border-miku-teal/10 pb-3">
								<h2
									id="logs-heading"
									className="text-lg font-bold text-miku-teal-dark flex items-center gap-2"
								>
									<span className="w-2 h-2 rounded-full bg-miku-teal animate-pulse" />
									System Logs <NoteIcon className="text-miku-teal" size={14} />
								</h2>
							</div>
							<LogsSection
								logs={logs}
								setLogs={setLogs}
								logContainerRef={
									logContainerRef as React.RefObject<HTMLDivElement>
								}
							/>
						</section>
						<section
							aria-labelledby="data-heading"
							className="glass-panel p-6 h-[600px] flex flex-col"
						>
							<div className="flex items-center justify-between mb-4 border-b-2 border-miku-pink/10 pb-3">
								<h2
									id="data-heading"
									className="text-lg font-bold text-miku-pink-dark flex items-center gap-2"
								>
									<span className="w-2 h-2 rounded-full bg-miku-pink animate-pulse" />
									Captured Data{" "}
									<HeartIcon className="text-miku-pink" size={14} />
								</h2>
								<span className="cute-badge flex items-center gap-1">
									<SparkleIcon className="text-miku-teal" size={12} />
									{crawledPages.length} items
								</span>
							</div>
							<CrawledPagesSection
								crawledPages={crawledPages}
								displayedPages={displayedPages}
								filterText={filterText}
								onFilterChange={setFilterText}
								onClearFilter={clearFilter}
								pageLimit={UI_LIMITS.MAX_PAGE_BUFFER}
							/>
						</section>
					</div>
				</main>

				<footer className="mt-12 pb-8 text-center">
					<div className="inline-block glass-panel px-8 py-4 rounded-full">
						<div className="flex items-center gap-4">
							<HeartIcon
								className="text-miku-pink animate-heart-beat"
								size={14}
							/>
							<span className="text-sm text-miku-text font-bold">
								Miku Miku Crawler{" "}
								<span className="text-miku-teal-dark">v2.0</span>
							</span>
							<HeartIcon
								className="text-miku-teal animate-heart-beat"
								size={14}
								style={{ animationDelay: "0.5s" }}
							/>

							<div className="w-px h-4 bg-miku-pink/30 mx-2" />

							<div className="flex items-center gap-2">
								<NoteIcon className="text-miku-teal" size={12} />
								<span className="text-xs text-miku-teal-dark font-bold">
									VOL
								</span>
								<input
									type="range"
									min="0"
									max="100"
									value={audioVol}
									onChange={(e) =>
										setAudioVol(Number.parseInt(e.target.value, 10))
									}
									aria-label="Volume control"
									title={`Volume: ${audioVol}%`}
									className="w-24 h-2 bg-miku-pink/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-gradient-to-r [&::-webkit-slider-thumb]:from-miku-teal [&::-webkit-slider-thumb]:to-miku-pink [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-md"
								/>
								<span className="text-xs text-miku-pink-dark font-bold w-8">
									{audioVol}%
								</span>
							</div>
						</div>
					</div>
				</footer>
			</div>

			<ConfigurationView
				isOpen={openedConfig}
				onClose={() => setOpenedConfig(false)}
				options={crawlOptions}
				onOptionsChange={setCrawlOptions}
				onSave={() => {
					addToast("success", "Configuration saved! ✨");
				}}
			/>

			<ExportDialog
				isOpen={openExportDialog}
				onClose={() => setOpenExportDialog(false)}
				onExport={handleExport}
			/>
		</div>
	);
}

export default App;
