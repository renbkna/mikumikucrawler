import {
	FileText,
	Globe,
	Loader2,
	Settings,
	Sparkles,
	Wand2,
	Wifi,
	WifiOff,
	Zap,
} from "lucide-react";
import { type ChangeEvent, memo } from "react";
import type { ConnectionState } from "../hooks";
import type { CrawlOptions } from "../types";
import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface CrawlerFormProps {
	target: string;
	setTarget: (target: string) => void;
	advancedOptions: CrawlOptions;
	isAttacking: boolean;
	startAttack: (isQuick?: boolean) => void;
	stopAttack: () => void;
	setOpenedConfig: (open: boolean) => void;
	connectionState: ConnectionState;
}

export const CrawlerForm = memo(function CrawlerForm({
	target,
	setTarget,
	advancedOptions,
	isAttacking,
	startAttack,
	stopAttack,
	setOpenedConfig,
	connectionState,
}: CrawlerFormProps) {
	const handleTargetChange = (e: ChangeEvent<HTMLInputElement>) => {
		setTarget(e.target.value);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" && !isAttacking && connectionState === "connected") {
			e.preventDefault();
			startAttack();
		}
	};

	// Compute connection status styles to avoid nested ternary
	const connectionStyles = (() => {
		switch (connectionState) {
			case "connected":
				return "bg-emerald-50 text-emerald-700 border-emerald-200 font-medium";
			case "connecting":
				return "bg-amber-50 text-amber-700 border-amber-200 animate-pulse font-medium";
			default:
				return "bg-rose-50 text-rose-700 border-rose-200 font-medium";
		}
	})();

	// Compute button label to avoid nested ternary
	const buttonLabel = (() => {
		if (connectionState === "connecting") return "Connecting~";
		if (isAttacking) {
			return (
				<>
					STOP! <HeartIcon className="text-white/80" size={12} />
				</>
			);
		}
		return (
			<>
				MIKU BEAM! <SparkleIcon className="text-white/80" size={12} />
			</>
		);
	})();

	return (
		<div className="relative mb-8 space-y-6">
			<div className="glass-panel rounded-[28px] p-8 relative overflow-hidden group">
				<div className="absolute -right-10 -top-10 w-32 h-32 bg-miku-teal/10 rounded-full blur-2xl group-hover:bg-miku-teal/20 transition-colors duration-500"></div>
				<div className="absolute -left-10 -bottom-10 w-32 h-32 bg-miku-pink/10 rounded-full blur-2xl group-hover:bg-miku-pink/20 transition-colors duration-500"></div>

				<div className="relative z-10 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6 items-end">
					<div className="space-y-3">
						<label
							htmlFor="target-url"
							className="text-sm font-bold text-miku-text/70 ml-4 flex items-center gap-2"
						>
							<NoteIcon className="text-miku-pink" size={12} />
							TARGET URL
							<NoteIcon className="text-miku-teal" size={12} />
						</label>
						<div className="relative">
							<input
								id="target-url"
								type="text"
								value={target}
								onChange={handleTargetChange}
								onKeyDown={handleKeyDown}
								placeholder="https://example.com"
								className="w-full px-6 py-4 rounded-2xl bg-white border-2 border-miku-pink/20 focus:border-miku-teal focus:ring-4 focus:ring-miku-teal/10 transition-all duration-300 outline-none text-gray-700 placeholder:text-gray-400 font-bold text-lg shadow-sm"
								disabled={isAttacking}
							/>
						</div>
					</div>

					<div className="flex gap-3 items-center">
						<output
							className={`p-3 rounded-2xl transition-all duration-300 border-2 flex items-center justify-center ${connectionStyles}`}
							title={`Status: ${connectionState}`}
							aria-live="polite"
						>
							<span className="sr-only">
								Connection status: {connectionState}
							</span>
							{connectionState === "connected" && <Wifi className="w-5 h-5" />}
							{connectionState === "connecting" && (
								<Loader2 className="w-5 h-5 animate-spin" />
							)}
							{connectionState === "disconnected" && (
								<WifiOff className="w-5 h-5" />
							)}
						</output>

						{!isAttacking && (
							<button
								type="button"
								onClick={() => startAttack(true)}
								disabled={connectionState !== "connected"}
								className="relative p-4 rounded-2xl bg-gradient-to-br from-amber-400 via-yellow-500 to-orange-500 text-white hover:scale-110 transition-all duration-300 shadow-lg shadow-amber-300/40 flex items-center justify-center group/zap disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 overflow-hidden"
								title="Lightning Strike! (Skip Animation)"
								aria-label="Lightning Strike Attack (Skip Animation)"
							>
								<SparkleIcon
									className="absolute -top-1 -right-1 text-white/80 group-hover/zap:animate-ping"
									size={10}
								/>
								<NoteIcon
									className="absolute -bottom-1 -left-1 text-white/60"
									size={10}
								/>
								<Zap className="w-5 h-5 group-hover/zap:fill-white group-hover/zap:animate-bounce transition-all" />
							</button>
						)}

						<button
							type="button"
							onClick={() => (isAttacking ? stopAttack() : startAttack())}
							disabled={connectionState !== "connected" && !isAttacking}
							className={`relative px-7 py-4 rounded-2xl font-black text-white shadow-xl transition-all duration-300 hover:scale-105 active:scale-95 flex items-center gap-3 text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 overflow-hidden ${
								isAttacking
									? "bg-gradient-to-r from-rose-500 via-pink-600 to-rose-500 shadow-miku-pink/40" // Darker pinks for white text
									: "bg-gradient-to-r from-teal-600 via-teal-500 to-emerald-600 shadow-miku-teal/40" // Darker teals for white text
							}`}
							aria-label={isAttacking ? "Stop Crawl" : "Start Miku Beam Crawl"}
						>
							<NoteIcon
								className="absolute top-1 left-3 text-white/40 animate-float"
								size={10}
							/>
							<SparkleIcon
								className="absolute bottom-1 right-3 text-white/40 animate-float"
								size={10}
								style={{ animationDelay: "0.5s" }}
							/>

							{isAttacking ? (
								<Sparkles className="w-5 h-5 animate-spin" />
							) : (
								<Wand2 className="w-5 h-5 animate-bounce" />
							)}

							<span className="relative flex items-center gap-1">
								{buttonLabel}
							</span>

							<span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></span>
						</button>

						<button
							type="button"
							onClick={() => setOpenedConfig(true)}
							className="p-4 rounded-2xl bg-white text-miku-text/50 hover:text-miku-teal border-2 border-miku-pink/20 hover:border-miku-teal/30 transition-all duration-300 shadow-sm hover:shadow-md hover:rotate-90"
							title="Settings"
							aria-label="Open Configuration"
						>
							<Settings className="w-5 h-5" />
						</button>
					</div>
				</div>
			</div>

			<div className="flex flex-wrap gap-4 justify-center">
				<div className="cute-badge">
					<Globe className="w-4 h-4 text-miku-teal" />
					Depth:{" "}
					<span className="text-teal-700 font-bold">
						{advancedOptions.crawlDepth}
					</span>
				</div>
				<div className="cute-badge">
					<FileText className="w-4 h-4 text-miku-pink" />
					Pages:{" "}
					<span className="text-pink-700 font-bold">
						{advancedOptions.maxPages}
					</span>
				</div>
				<div className="cute-badge">
					<Zap className="w-4 h-4 text-amber-400" />
					Delay:{" "}
					<span className="text-amber-700 font-bold">
						{advancedOptions.crawlDelay}ms
					</span>
				</div>
			</div>
		</div>
	);
});

CrawlerForm.displayName = "CrawlerForm";
