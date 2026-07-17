import { Heart, History, Music } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { shouldResetTheatreStatus, type TheatreStatus } from "../shared/theatreStatus.js";
import { ActionButtons } from "./components/ActionButtons";
import { ConfigurationView } from "./components/ConfigurationView";
import { CrawledPagesSection } from "./components/CrawledPagesSection";
import { CrawlerForm } from "./components/CrawlerForm";
import { ExportDialog } from "./components/ExportDialog";
import { HeartIcon, NoteIcon, SparkleIcon } from "./components/KawaiiIcons";
import { LogsSection } from "./components/LogsSection";
import { MikuBanner } from "./components/MikuBanner";
import { ProgressBar } from "./components/ProgressBar";
import { ResumeSessionsPanel } from "./components/ResumeSessionsPanel";
import { StatsGrid } from "./components/StatsGrid";
import { StatsVisualizer } from "./components/StatsVisualizer";
import { TheatreOverlay } from "./components/TheatreOverlay";
import { ToastNotification } from "./components/ToastNotification";
import { UI_LIMITS } from "./constants";
import { useCrawlController } from "./hooks/useCrawlController";
import { useToast } from "./hooks/useToast";

function App() {
	const [theatreStatus, setTheatreStatus] = useState<TheatreStatus>("idle");
	const [openedConfig, setOpenedConfig] = useState(false);
	const [openExportDialog, setOpenExportDialog] = useState(false);
	const [openResumePanel, setOpenResumePanel] = useState(false);
	const [showDetails, setShowDetails] = useState(false);
	const [audioVol, setAudioVol] = useState(100);

	const { toasts, addToast, dismissToast } = useToast();

	const {
		target,
		crawlOptions,
		setCrawlOptions,
		handleTargetChange,
		stats,
		queueStats,
		crawledPages,
		progress,
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

	const pauseAttack = useCallback(() => {
		void pauseCrawl();
	}, [pauseCrawl]);

	const forceStopAttack = useCallback(() => {
		if (!window.confirm("Force stop this crawl and clear its pending queue?")) {
			return;
		}
		void forceStopCrawl();
	}, [forceStopCrawl]);

	useEffect(() => {
		if (shouldResetTheatreStatus(theatreStatus, isAttacking)) {
			setTheatreStatus("idle");
		}
	}, [isAttacking, theatreStatus]);

	const handleExport = useCallback(
		(format: string) => {
			void exportCrawl(format);
		},
		[exportCrawl],
	);

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

	const handleRefreshResumableSessions = useCallback(() => {
		void refreshResumableSessions();
	}, [refreshResumableSessions]);

	const handleBeamStart = useCallback(() => {
		setTheatreStatus("beam");
	}, []);

	const handleTheatreComplete = useCallback(() => {
		setTheatreStatus("live");
	}, []);

	const isUIHidden = theatreStatus === "blackout" || theatreStatus === "counting";
	const isModalOpen = openedConfig || openExportDialog || openResumePanel;

	return (
		<div className="relative w-screen h-screen overflow-hidden text-miku-text font-sans">
			<TheatreOverlay
				status={theatreStatus}
				onBeamStart={handleBeamStart}
				onComplete={handleTheatreComplete}
				isCrawlActive={canPause || canForceStop}
				onStop={canPause ? pauseAttack : forceStopAttack}
				stopLabel={canPause ? "Pause" : "Force Stop"}
				volume={audioVol}
			/>

			<div
				className={`relative w-full h-full px-4 pb-12 transition-all duration-1000 ${isUIHidden ? "opacity-0 scale-95 blur-xl pointer-events-none" : "opacity-100 scale-100 blur-0"} ${isModalOpen ? "overflow-hidden" : "overflow-y-auto"}`}
			>
				<div className="app-atmosphere fixed inset-0 pointer-events-none overflow-hidden z-0">
					<div className="absolute top-10 left-10 w-32 h-32 bg-miku-teal/10 rounded-full blur-3xl animate-float" />
					<div
						className="absolute bottom-20 right-20 w-40 h-40 bg-miku-pink/10 rounded-full blur-3xl animate-float"
						style={{ animationDelay: "1s" }}
					/>
				</div>

				<div className="fixed top-4 right-4 z-50 space-y-2">
					{toasts.map((toast: (typeof toasts)[number]) => (
						<ToastNotification key={toast.id} toast={toast} onDismiss={dismissToast} />
					))}
				</div>

				<main className="relative z-10 max-w-7xl mx-auto space-y-3">
					<header className="flex items-center justify-center py-4">
						<div className="brand-shell glass-panel px-4 py-2 inline-flex items-center gap-3">
							<div className="hidden">
								<Music className="w-5 h-5 text-white" />
							</div>

							<div>
								<h1 className="text-lg font-bold uppercase tracking-[0.12em] flex items-center gap-2 text-miku-accent">
									<SparkleIcon className="text-miku-accent/40" size={15} />
									<span>Miku</span>
									<HeartIcon className="hidden" size={16} />
									<span>Miku</span>
									<HeartIcon className="hidden" size={16} />
									<span>Crawler</span>
								</h1>
								<p className="hidden">web crawling, but cuter</p>
							</div>

							<div className="hidden">
								<Heart className="w-5 h-5 text-white animate-heart-beat" fill="white" />
							</div>
						</div>
					</header>

					<section
						aria-label="Crawler Control"
						className="control-stage glass-panel relative group transition-all duration-500"
					>
						<MikuBanner active={theatreStatus === "beam" || isAttacking} />

						<CrawlerForm
							target={target}
							setTarget={handleTargetChange}
							crawlOptions={crawlOptions}
							isAttacking={isAttacking}
							canStart={canStart}
							canForceStop={canForceStop}
							canPause={canPause}
							startAttack={(isQuick) => {
								void startAttack(isQuick);
							}}
							pauseAttack={pauseAttack}
							forceStopAttack={forceStopAttack}
							setOpenedConfig={setOpenedConfig}
							connectionState={connectionState}
						/>
					</section>

					{resumableSessions.length > 0 && !isAttacking && (
						<div className="flex items-center justify-between px-5 py-3 rounded-xl border border-miku-border bg-white/70 text-miku-text shadow-sm">
							<div className="flex items-center gap-2 text-sm font-bold">
								<History className="w-4 h-4 shrink-0" />
								{resumableSessions.length} resumable crawl
								{resumableSessions.length !== 1 ? "s" : ""} found
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
						<div className="metric-group lg:col-span-2 glass-panel">
							<StatsGrid stats={stats} queueStats={queueStats} isAttacking={isAttacking} />
						</div>
						<div className="glass-panel p-5 flex flex-col justify-center">
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
									System Logs <NoteIcon className="hidden" size={14} />
								</h2>
							</div>
							<LogsSection logs={logs} clearLogs={clearLogs} />
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
									Captured Data <HeartIcon className="hidden" size={14} />
								</h2>
								<span className="cute-badge flex items-center gap-1">
									<SparkleIcon className="hidden" size={12} />
									{crawledPages.length} items
								</span>
							</div>
							<CrawledPagesSection
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
						</section>
					</div>
				</main>

				<footer className="mt-4 pb-6 text-center">
					<div className="inline-block glass-panel px-6 py-3 rounded-full">
						<div className="flex items-center gap-4">
							<HeartIcon className="hidden" size={14} />
							<span className="hidden">
								Miku Miku Crawler <span className="text-miku-teal-dark">v3.0.0</span>
							</span>
							<HeartIcon className="hidden" size={14} style={{ animationDelay: "0.5s" }} />

							<div className="hidden" />

							<div className="flex items-center gap-2">
								<NoteIcon className="text-miku-accent/50" size={13} />
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

			<ConfigurationView
				isOpen={openedConfig}
				onClose={() => setOpenedConfig(false)}
				options={crawlOptions}
				onSave={(options) => {
					setCrawlOptions(options);
					addToast("success", "Configuration saved! ✨");
				}}
			/>

			<ExportDialog
				isOpen={openExportDialog}
				onClose={() => setOpenExportDialog(false)}
				onExport={handleExport}
			/>

			<ResumeSessionsPanel
				isOpen={openResumePanel}
				sessions={resumableSessions}
				isLoading={resumableSessionsLoading}
				fetchError={resumableSessionsError}
				deletingId={deletingResumableSessionId}
				resumingId={resumingResumableSessionId}
				onRefresh={handleRefreshResumableSessions}
				onDelete={(sessionId) => {
					void deleteResumableSession(sessionId);
				}}
				onClose={() => setOpenResumePanel(false)}
				onResume={handleResumeSession}
			/>
		</div>
	);
}

export default App;
