import { Heart, History, Music } from "lucide-react";
import { useCallback, useRef, useState } from "react";
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
	ResumeSessionsPanel,
	SparkleIcon,
	StatsGrid,
	StatsVisualizer,
	ToastNotification,
} from "./components";
import { MikuBanner } from "./components/MikuBanner";
import { TheatreOverlay } from "./components/TheatreOverlay";
import { UI_LIMITS } from "./constants";
import { useCrawlController, useToast } from "./hooks";

function App() {
	const [theatreStatus, setTheatreStatus] = useState<
		"idle" | "blackout" | "counting" | "beam" | "live"
	>("idle");
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
		filterText,
		setFilterText,
		displayedPages,
		clearFilter,
		isAttacking,
		connectionState,
		interruptedSessions,
		interruptedSessionsLoading,
		interruptedSessionsError,
		deletingInterruptedSessionId,
		refreshInterruptedSessions,
		deleteInterruptedSession,
		startCrawl,
		stopCrawl,
		resumeCrawl,
		exportCrawl,
	} = useCrawlController({ addToast });

	const logContainerRef = useRef<HTMLDivElement>(null);

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

	const stopAttack = useCallback(() => {
		void stopCrawl();
		setTheatreStatus("idle");
	}, [stopCrawl]);

	const handleExport = useCallback(
		(format: string) => {
			void exportCrawl(format);
		},
		[exportCrawl],
	);

	const handleResumeSession = useCallback(
		(sessionId: string, resumedTarget: string) => {
			void resumeCrawl(sessionId, resumedTarget).then((resumed: boolean) => {
				if (resumed) {
					setTheatreStatus("live");
				}
			});
		},
		[resumeCrawl],
	);

	const handleBeamStart = useCallback(() => {
		setTheatreStatus("beam");
	}, []);

	const handleTheatreComplete = useCallback(() => {
		setTheatreStatus("live");
	}, []);

	const isUIHidden =
		theatreStatus === "blackout" || theatreStatus === "counting";
	const isModalOpen = openedConfig || openExportDialog || openResumePanel;

	return (
		<div className="relative w-screen h-screen overflow-hidden text-miku-text font-sans">
			<TheatreOverlay
				status={theatreStatus}
				onBeamStart={handleBeamStart}
				onComplete={handleTheatreComplete}
				volume={audioVol}
			/>

			<div
				className={`relative w-full h-full pt-4 px-4 pb-16 transition-all duration-1000 ${isUIHidden ? "opacity-0 scale-95 blur-xl pointer-events-none" : "opacity-100 scale-100 blur-0"} ${isModalOpen ? "overflow-hidden" : "overflow-y-auto"}`}
			>
				<div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
					<div className="absolute top-10 left-10 w-32 h-32 bg-miku-teal/10 rounded-full blur-3xl animate-float" />
					<div
						className="absolute bottom-20 right-20 w-40 h-40 bg-miku-pink/10 rounded-full blur-3xl animate-float"
						style={{ animationDelay: "1s" }}
					/>
				</div>

				<div className="fixed top-4 right-4 z-50 space-y-2">
					{toasts.map((toast: (typeof toasts)[number]) => (
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

					{interruptedSessions.length > 0 && !isAttacking && (
						<div className="flex items-center justify-between px-5 py-3 rounded-2xl border-2 border-amber-200 bg-amber-50 text-amber-800 shadow-sm">
							<div className="flex items-center gap-2 text-sm font-bold">
								<History className="w-4 h-4 shrink-0" />
								{interruptedSessions.length} interrupted crawl
								{interruptedSessions.length !== 1 ? "s" : ""} found
							</div>
							<button
								type="button"
								onClick={() => setOpenResumePanel(true)}
								className="px-4 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold transition-colors shadow-sm"
							>
								View &amp; Resume
							</button>
						</div>
					)}

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
								clearLogs={clearLogs}
								logContainerRef={logContainerRef}
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
								<span className="text-miku-teal-dark">v3.0.0</span>
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

			<ResumeSessionsPanel
				isOpen={openResumePanel}
				sessions={interruptedSessions}
				isLoading={interruptedSessionsLoading}
				fetchError={interruptedSessionsError}
				deletingId={deletingInterruptedSessionId}
				onRefresh={refreshInterruptedSessions}
				onDelete={(sessionId) => {
					void deleteInterruptedSession(sessionId);
				}}
				onClose={() => setOpenResumePanel(false)}
				onResume={handleResumeSession}
			/>
		</div>
	);
}

export default App;
