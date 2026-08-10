import { History, Music2, Sparkles } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { ActionButtons } from "./components/ActionButtons";
import { CrawlerForm } from "./components/CrawlerForm";
import { MikuBanner } from "./components/MikuBanner";
import { ProgressBar } from "./components/ProgressBar";
import { StatsGrid } from "./components/StatsGrid";
import type { TheatreStatus } from "./components/TheatreOverlay";
import { ToastNotification } from "./components/ToastNotification";
import { UI_LIMITS } from "./constants";
import { isTerminalRunPhase } from "./hooks/crawlControllerState";
import { useCrawlController } from "./hooks/useCrawlController";
import { useToast } from "./hooks/useToast";

const ConfigurationView = lazy(() =>
	import("./components/ConfigurationView").then(({ ConfigurationView }) => ({
		default: ConfigurationView,
	})),
);
const CrawledPagesSection = lazy(() =>
	import("./components/CrawledPagesSection").then(({ CrawledPagesSection }) => ({
		default: CrawledPagesSection,
	})),
);
const ExportDialog = lazy(() =>
	import("./components/ExportDialog").then(({ ExportDialog }) => ({ default: ExportDialog })),
);
const LogsSection = lazy(() =>
	import("./components/LogsSection").then(({ LogsSection }) => ({ default: LogsSection })),
);
const ResumeSessionsPanel = lazy(() =>
	import("./components/ResumeSessionsPanel").then(({ ResumeSessionsPanel }) => ({
		default: ResumeSessionsPanel,
	})),
);
const StatsVisualizer = lazy(() =>
	import("./components/StatsVisualizer").then(({ StatsVisualizer }) => ({
		default: StatsVisualizer,
	})),
);
const TheatreOverlay = lazy(() =>
	import("./components/TheatreOverlay").then(({ TheatreOverlay }) => ({
		default: TheatreOverlay,
	})),
);

function App() {
	const [theatreStatus, setTheatreStatus] = useState<TheatreStatus>("idle");
	const [openedConfig, setOpenedConfig] = useState(false);
	const [openExportDialog, setOpenExportDialog] = useState(false);
	const [openResumePanel, setOpenResumePanel] = useState(false);
	const [showDetails, setShowDetails] = useState(false);
	const [audioVol, setAudioVol] = useState(100);

	const { toasts, addToast, dismissToast } = useToast();

	const {
		activeCrawlId,
		target,
		crawlOptions,
		activeCrawlOptions,
		setCrawlOptions,
		handleTargetChange,
		stats,
		queueStats,
		crawledPages,
		storedPageCount,
		progress,
		runPhase,
		logs,
		clearLogs,
		searchQuery,
		setSearchQuery,
		searchResultCount,
		isSearchingPages,
		pageSearchError,
		displayedPages,
		clearSearch,
		isAttacking,
		canStart,
		canForceStop,
		canPause,
		connectionState,
		resumableSessions,
		resumableSessionsLoading,
		resumableSessionsError,
		deletingResumableSessionId,
		resumingResumableSessionId,
		refreshResumableSessions,
		deleteResumableSession,
		startCrawl,
		pauseCrawl,
		forceStopCrawl,
		resumeCrawl,
		exportCrawl,
	} = useCrawlController({ addToast });

	const startAttack = useCallback(
		async (isQuick = false) => {
			const started = await startCrawl(isQuick);
			if (!started) {
				return;
			}

			if (isQuick) {
				setTheatreStatus("live");
			} else {
				setTheatreStatus("blackout");
			}
		},
		[startCrawl],
	);

	const forceStopAttack = useCallback(() => {
		if (!window.confirm("Force stop this crawl and clear its pending queue?")) {
			return;
		}
		void forceStopCrawl();
	}, [forceStopCrawl]);

	useEffect(() => {
		if (theatreStatus !== "idle" && !isAttacking) {
			setTheatreStatus("idle");
		}
	}, [isAttacking, theatreStatus]);

	const handleResumeSession = useCallback(
		(sessionId: string) => {
			return resumeCrawl(sessionId).then((resumed: boolean) => {
				if (resumed) {
					setTheatreStatus("live");
				}
				return resumed;
			});
		},
		[resumeCrawl],
	);

	const handleTheatreComplete = useCallback(() => {
		setTheatreStatus("live");
	}, []);

	const isUIHidden = theatreStatus === "blackout";
	const isModalOpen = openedConfig || openExportDialog || openResumePanel;

	return (
		<div className="relative w-screen h-screen overflow-hidden text-miku-text font-sans">
			{theatreStatus !== "idle" && (
				<Suspense fallback={<div className="fixed inset-0 z-[100] bg-black" />}>
					<TheatreOverlay
						status={theatreStatus}
						onComplete={handleTheatreComplete}
						isCrawlActive={canPause || canForceStop}
						onStop={canPause ? pauseCrawl : forceStopAttack}
						stopLabel={canPause ? "Pause" : "Force Stop"}
						volume={audioVol}
					/>
				</Suspense>
			)}

			<div
				className={`relative w-full h-full px-4 pb-12 transition-all duration-1000 ${isUIHidden ? "opacity-0 scale-95 blur-xl pointer-events-none" : "opacity-100 scale-100 blur-0"} ${isModalOpen ? "overflow-hidden" : "overflow-y-auto"}`}
			>
				<div className="fixed top-4 right-4 z-50 space-y-2">
					{toasts.map((toast: (typeof toasts)[number]) => (
						<ToastNotification key={toast.id} toast={toast} onDismiss={dismissToast} />
					))}
				</div>

				<main className="relative z-10 max-w-7xl mx-auto space-y-3">
					<header className="flex items-center justify-center py-4">
						<div className="px-4 py-2 inline-flex items-center gap-3">
							<div>
								<h1 className="text-lg font-bold uppercase tracking-[0.12em] flex items-center gap-2 text-miku-accent">
									<Sparkles className="text-miku-accent/40" size={15} />
									<span>Miku</span>
									<span>Miku</span>
									<span>Crawler</span>
								</h1>
							</div>
						</div>
					</header>

					<section
						aria-label="Crawler Control"
						className="relative group transition-all duration-500"
					>
						<MikuBanner active={isAttacking} />

						<CrawlerForm
							target={target}
							setTarget={handleTargetChange}
							crawlOptions={isAttacking ? (activeCrawlOptions ?? crawlOptions) : crawlOptions}
							isAttacking={isAttacking}
							canStart={canStart}
							canForceStop={canForceStop}
							canPause={canPause}
							startAttack={startAttack}
							pauseAttack={pauseCrawl}
							forceStopAttack={forceStopAttack}
							setOpenedConfig={setOpenedConfig}
							connectionState={connectionState}
						/>
					</section>

					{!isAttacking &&
						(resumableSessions.length > 0 ||
							resumableSessionsLoading ||
							resumableSessionsError) && (
							<div className="flex items-center justify-between px-5 py-3 rounded-xl border border-miku-border bg-white/70 text-miku-text shadow-sm">
								<div className="flex items-center gap-2 text-sm font-bold">
									<History className="w-4 h-4 shrink-0" />
									{resumableSessionsError
										? "Saved crawls need attention"
										: resumableSessionsLoading
											? "Checking saved crawls…"
											: `${resumableSessions.length} resumable crawl${resumableSessions.length !== 1 ? "s" : ""} found`}
								</div>
								<button
									type="button"
									onClick={() => setOpenResumePanel(true)}
									className="px-4 py-1.5 rounded-lg bg-miku-teal hover:bg-miku-teal-dark text-white text-xs font-bold transition-colors"
								>
									View &amp; Resume
								</button>
							</div>
						)}

					<section aria-label="Statistics" className="grid grid-cols-1 lg:grid-cols-3 gap-3">
						<div className="lg:col-span-2">
							<StatsGrid stats={stats} queueStats={queueStats} isAttacking={isAttacking} />
						</div>
						<div className="glass-panel p-5 flex flex-col justify-center">
							<ProgressBar progress={progress} runPhase={runPhase} />
						</div>
					</section>

					<ActionButtons
						storedPageCount={storedPageCount}
						setOpenExportDialog={setOpenExportDialog}
						showDetails={showDetails}
						setShowDetails={setShowDetails}
					/>

					{showDetails && (
						<Suspense fallback={null}>
							<StatsVisualizer stats={stats} queueStats={queueStats} />
						</Suspense>
					)}

					<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
						<section
							aria-labelledby="logs-heading"
							className="glass-panel p-5 h-[440px] flex flex-col"
						>
							<div className="flex items-center justify-between mb-3 border-b border-miku-teal/15 pb-3">
								<h2
									id="logs-heading"
									className="text-base font-bold uppercase tracking-wide text-miku-teal-dark flex items-center gap-2"
								>
									<span className="w-2 h-2 rounded-full bg-miku-teal animate-pulse" />
									System Logs
								</h2>
							</div>
							{logs.length > 0 ? (
								<Suspense fallback={null}>
									<LogsSection logs={logs} clearLogs={clearLogs} />
								</Suspense>
							) : (
								<div className="h-full flex flex-col items-center justify-center text-miku-text/40">
									<Music2 className="text-miku-teal/35 mb-3" size={34} />
									<p className="font-medium">Waiting for Miku to start writing...</p>
									<p className="text-xs mt-1 opacity-60">
										Logs will appear here when crawling begins
									</p>
								</div>
							)}
						</section>
						<section
							aria-labelledby="data-heading"
							className="glass-panel p-5 h-[440px] flex flex-col"
						>
							<div className="flex items-center justify-between mb-3 border-b border-miku-pink/15 pb-3">
								<h2
									id="data-heading"
									className="text-base font-bold uppercase tracking-wide text-miku-pink-dark flex items-center gap-2"
								>
									<span className="w-2 h-2 rounded-full bg-miku-pink animate-pulse" />
									Captured Data
								</h2>
								<span className="cute-badge flex items-center gap-1">{storedPageCount} stored</span>
							</div>
							{activeCrawlId ? (
								<Suspense fallback={null}>
									<CrawledPagesSection
										crawlId={activeCrawlId}
										crawledPages={crawledPages}
										displayedPages={displayedPages}
										searchQuery={searchQuery}
										onSearchChange={setSearchQuery}
										onClearSearch={clearSearch}
										searchResultCount={searchResultCount}
										isSearching={isSearchingPages}
										searchError={pageSearchError}
										pageLimit={UI_LIMITS.MAX_PAGE_BUFFER}
									/>
								</Suspense>
							) : (
								<div className="h-full flex flex-col items-center justify-center text-miku-text/40">
									<p className="font-semibold text-base">No pages crawled yet...</p>
									<p className="text-xs mt-1 font-medium">Start the Miku Beam to begin!</p>
								</div>
							)}
						</section>
					</div>
				</main>

				<footer className="mt-4 pb-6 text-center">
					<div className="inline-block glass-panel px-6 py-3 rounded-full">
						<div className="flex items-center gap-4">
							<div className="flex items-center gap-2">
								<Music2 className="text-miku-accent/50" size={13} />
								<span className="text-xs text-miku-teal-dark font-bold">VOL</span>
								<input
									type="range"
									min="0"
									max="100"
									value={audioVol}
									onChange={(e) => setAudioVol(Number.parseInt(e.target.value, 10))}
									aria-label="Volume control"
									title={`Volume: ${audioVol}%`}
									className="soft-range w-48 h-1.5 bg-miku-teal/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-miku-teal [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-sm"
								/>
								<span className="text-xs text-miku-accent font-bold w-8">{audioVol}%</span>
							</div>
						</div>
					</div>
				</footer>
			</div>

			<Suspense fallback={null}>
				{openedConfig && (
					<ConfigurationView
						isOpen
						onClose={() => setOpenedConfig(false)}
						options={crawlOptions}
						editingNextRun={activeCrawlOptions !== null && !isTerminalRunPhase(runPhase)}
						onSave={(options) => {
							setCrawlOptions(options);
							addToast("success", "Configuration saved! ✨");
						}}
					/>
				)}
				{openExportDialog && (
					<ExportDialog isOpen onClose={() => setOpenExportDialog(false)} onExport={exportCrawl} />
				)}
				{openResumePanel && (
					<ResumeSessionsPanel
						isOpen
						sessions={resumableSessions}
						isLoading={resumableSessionsLoading}
						fetchError={resumableSessionsError}
						deletingId={deletingResumableSessionId}
						resumingId={resumingResumableSessionId}
						onRefresh={refreshResumableSessions}
						onDelete={(sessionId) => {
							void deleteResumableSession(sessionId);
						}}
						onClose={() => setOpenResumePanel(false)}
						onResume={handleResumeSession}
					/>
				)}
			</Suspense>
		</div>
	);
}

export default App;
