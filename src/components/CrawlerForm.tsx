import {
	CircleStop,
	FileText,
	Globe,
	Loader2,
	Pause,
	Settings,
	Sparkles,
	Wand2,
	Wifi,
	WifiOff,
	Zap,
} from "lucide-react";
import { type ChangeEvent, memo, useCallback, useMemo } from "react";
import type { CrawlOptions } from "../../shared/contracts/index.js";
import { validatePublicHttpUrl } from "../../shared/url";
import type { ConnectionState } from "../hooks/crawlControllerState";
import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface CrawlerFormProps {
	target: string;
	setTarget: (target: string) => void;
	crawlOptions: CrawlOptions;
	isAttacking: boolean;
	canStart: boolean;
	canForceStop: boolean;
	canPause: boolean;
	startAttack: (isQuick?: boolean) => void;
	pauseAttack: () => void;
	forceStopAttack: () => void;
	setOpenedConfig: (open: boolean) => void;
	connectionState: ConnectionState;
}

export const CrawlerForm = memo(function CrawlerForm({
	target,
	setTarget,
	crawlOptions,
	isAttacking,
	canStart,
	canForceStop,
	canPause,
	startAttack,
	pauseAttack,
	forceStopAttack,
	setOpenedConfig,
	connectionState,
}: CrawlerFormProps) {
	const validateUrl = useCallback((input: string): string | null => {
		if (!input) return null;
		const result = validatePublicHttpUrl(input, { allowLocalhost: import.meta.env.DEV });
		return "error" in result ? result.error : null;
	}, []);
	const validationError = useMemo(() => validateUrl(target), [target, validateUrl]);
	const hasRunnableTarget = target.trim().length > 0;

	const handleTargetChange = (e: ChangeEvent<HTMLInputElement>) => {
		const val = e.target.value;
		setTarget(val);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" && canStart && !validationError && hasRunnableTarget) {
			e.preventDefault();
			startAttack();
		}
	};

	const connectionStyles = (() => {
		switch (connectionState) {
			case "connected":
				return "bg-miku-teal/8 text-miku-teal-dark border-miku-teal/35 font-medium";
			case "connecting":
				return "bg-miku-accent/5 text-miku-accent border-miku-accent/20 animate-pulse font-medium";
			default:
				return "bg-miku-pink/8 text-miku-pink-dark border-miku-pink/30 font-medium";
		}
	})();

	const buttonLabel = (() => {
		if (connectionState === "connecting") return "Connecting~";
		if (isAttacking) {
			return (
				<>
					PAUSE <HeartIcon className="hidden" size={12} />
				</>
			);
		}
		return (
			<>
				MIKU BEAM! <SparkleIcon className="hidden" size={12} />
			</>
		);
	})();

	return (
		<div className="relative mb-0 space-y-0">
			<div className="glass-panel rounded-t-[18px] rounded-b-none p-5 relative overflow-hidden group">
				<div className="hidden" />
				<div className="hidden" />

				<div className="relative z-10 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-end">
					<div className="space-y-2">
						<label
							htmlFor="target-url"
							className="text-xs font-bold uppercase tracking-[0.08em] text-miku-accent/65 ml-1 flex items-center gap-2"
						>
							<NoteIcon className="hidden" size={12} />
							TARGET URL
							<NoteIcon className="hidden" size={12} />
						</label>
						<div className="relative">
							<input
								id="target-url"
								type="text"
								value={target}
								onChange={handleTargetChange}
								onKeyDown={handleKeyDown}
								placeholder="https://example.com"
								className={`w-full px-5 py-3.5 rounded-xl bg-white/75 border focus:ring-3 transition-all duration-300 outline-none text-miku-text placeholder:text-miku-text/35 font-medium text-base shadow-none ${
									validationError
										? "border-rose-300 focus:border-rose-400 focus:ring-rose-300/10"
										: "border-miku-accent/20 focus:border-miku-teal focus:ring-miku-teal/10"
								}`}
								disabled={isAttacking}
							/>
						</div>
						{validationError && (
							<p className="text-rose-500 text-xs font-bold ml-4 animate-pulse flex items-center gap-1">
								<WifiOff className="w-3 h-3" />
								{validationError}
							</p>
						)}
					</div>

					<div className="flex gap-3 items-center">
						<output
							className={`p-3.5 rounded-xl transition-all duration-300 border flex items-center justify-center ${connectionStyles}`}
							title={`Status: ${connectionState}`}
							aria-live="polite"
						>
							<span className="sr-only">Connection status: {connectionState}</span>
							{connectionState === "connected" && <Wifi className="w-5 h-5" />}
							{connectionState === "connecting" && <Loader2 className="w-5 h-5 animate-spin" />}
							{connectionState === "disconnected" && <WifiOff className="w-5 h-5" />}
						</output>

						{!isAttacking && (
							<button
								type="button"
								onClick={() => startAttack(true)}
								disabled={!canStart || !!validationError || !hasRunnableTarget}
								className="relative p-3.5 rounded-xl bg-white/75 text-miku-pink hover:bg-miku-pink/8 border border-miku-accent/20 hover:border-miku-pink/40 transition-all duration-300 flex items-center justify-center group/zap disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden"
								title="Lightning Strike! (Skip Animation)"
								aria-label="Lightning Strike Attack (Skip Animation)"
							>
								<SparkleIcon className="hidden" size={10} />
								<NoteIcon className="hidden" size={10} />
								<Zap className="w-5 h-5" />
							</button>
						)}

						<button
							type="button"
							onClick={() => (isAttacking && canPause ? pauseAttack() : startAttack())}
							disabled={
								isAttacking ? !canPause : !canStart || !!validationError || !hasRunnableTarget
							}
							className={`relative px-7 py-3.5 rounded-xl font-bold text-white transition-all duration-300 active:scale-[0.98] flex items-center gap-3 text-base disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden ${
								isAttacking
									? "bg-miku-pink hover:bg-miku-pink-dark"
									: "bg-miku-teal hover:bg-miku-teal-dark shadow-[0_8px_20px_rgba(105,201,229,0.18)]"
							}`}
							aria-label={isAttacking ? "Pause Crawl" : "Start Miku Beam Crawl"}
						>
							<NoteIcon className="hidden" size={10} />
							<SparkleIcon className="hidden" size={10} style={{ animationDelay: "0.5s" }} />

							{isAttacking ? <Pause className="w-5 h-5" /> : <Wand2 className="w-5 h-5" />}

							<span className="relative flex items-center gap-1">{buttonLabel}</span>

							<span className="hidden" />
						</button>

						{canForceStop && (
							<button
								type="button"
								onClick={forceStopAttack}
								className="relative px-4 py-3.5 rounded-xl font-bold text-white transition-all duration-300 active:scale-[0.98] flex items-center gap-2 text-sm bg-rose-500 hover:bg-rose-600"
								aria-label="Force Stop Crawl"
								title="Force stop and clear pending queue"
							>
								<CircleStop className="w-5 h-5" />
								<span>Force Stop</span>
							</button>
						)}

						<button
							type="button"
							onClick={() => setOpenedConfig(true)}
							className="p-3.5 rounded-xl bg-white/75 text-miku-accent/60 hover:text-miku-accent border border-miku-accent/20 hover:border-miku-accent/35 transition-all duration-300"
							title="Settings"
							aria-label="Open Configuration"
						>
							<Settings className="w-5 h-5" />
						</button>
					</div>
				</div>
			</div>

			<div className="crawl-readouts flex flex-wrap gap-1 justify-center px-4 py-3 rounded-b-[18px] border border-t-0 border-miku-border bg-white/55">
				<div className="cute-badge">
					<Globe className="hidden" />
					Depth: <span className="text-teal-700 font-bold">{crawlOptions.crawlDepth}</span>
				</div>
				<div className="cute-badge">
					<FileText className="hidden" />
					Pages: <span className="text-pink-700 font-bold">{crawlOptions.maxPages}</span>
				</div>
				<div className="cute-badge">
					<Zap className="hidden" />
					Method:{" "}
					<span className="text-miku-teal-dark font-bold capitalize">
						{crawlOptions.crawlMethod}
					</span>
				</div>
				<div className={`cute-badge ${crawlOptions.dynamic ? "" : "opacity-50"}`}>
					<Sparkles
						className={`w-4 h-4 ${crawlOptions.dynamic ? "text-miku-teal" : "text-miku-text/40"}`}
					/>
					JS:{" "}
					<span
						className={`font-bold ${crawlOptions.dynamic ? "text-teal-700" : "text-miku-text/40"}`}
					>
						{crawlOptions.dynamic ? "on" : "off"}
					</span>
				</div>
			</div>
		</div>
	);
});

CrawlerForm.displayName = "CrawlerForm";
