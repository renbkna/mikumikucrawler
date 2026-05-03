import { Coffee, Database, TriangleAlert } from "lucide-react";
import type { CrawlOptions } from "../../shared/contracts/index.js";
import { CRAWL_OPTION_BOUNDS, isCrawlMethod } from "../../shared/crawl.js";
import { useDialogModal } from "../hooks";
import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface ConfigurationViewProps {
	isOpen: boolean;
	onClose: () => void;
	options: CrawlOptions;
	onOptionsChange: (options: CrawlOptions) => void;
	onSave: () => void;
}

function clampCrawlOption(
	key: keyof typeof CRAWL_OPTION_BOUNDS,
	rawValue: string,
): number {
	const bounds = CRAWL_OPTION_BOUNDS[key];
	return Math.min(
		bounds.max,
		Math.max(bounds.min, Number(rawValue) || bounds.min),
	);
}

export function ConfigurationView({
	isOpen,
	onClose,
	options,
	onOptionsChange,
	onSave,
}: Readonly<ConfigurationViewProps>) {
	const { dialogRef, modalRef, initialFocusRef } =
		useDialogModal<HTMLDivElement>({
			isOpen,
			onClose,
		});

	if (!isOpen) return null;

	const crawlMethodDesc = {
		links:
			"Follows internal HTML links and skips media metadata in saved results",
		media:
			"Follows internal HTML links and keeps extracted image, video, and audio metadata",
		full: "Follows internal and external HTML links and keeps extracted media metadata",
	}[options.crawlMethod];
	const mediaRetentionDisabled = options.crawlMethod === "links";

	return (
		<dialog
			ref={dialogRef}
			aria-labelledby="config-dialog-title"
			className="fixed inset-0 z-50 flex items-center justify-center p-4 m-0 w-full h-full bg-transparent border-none backdrop:bg-black/20 backdrop:backdrop-blur-sm"
			onClose={onClose}
		>
			<button
				type="button"
				className="absolute inset-0 w-full h-full bg-transparent border-none cursor-default"
				onClick={onClose}
				aria-label="Close dialog"
				tabIndex={-1}
			/>
			<div
				ref={modalRef}
				className="relative w-full max-w-xl p-6 bg-white rounded-3xl shadow-xl border-2 border-miku-pink/20 max-h-[90vh] overflow-y-auto animate-pop focus:outline-none"
			>
				<div className="flex items-center justify-between mb-6">
					<h2
						id="config-dialog-title"
						className="text-2xl font-black gradient-text tracking-tight flex items-center gap-2"
					>
						<NoteIcon className="text-miku-teal" size={20} />
						Advanced Configuration
						<NoteIcon className="text-miku-pink" size={20} />
					</h2>
					<button
						type="button"
						ref={initialFocusRef}
						onClick={onClose}
						className="p-2 rounded-full hover:bg-miku-pink/10 text-miku-text/40 hover:text-miku-pink transition-colors"
						aria-label="Close configuration dialog"
					>
						✕
					</button>
				</div>

				<div className="space-y-6">
					{/* ── Performance Settings ─────────────────────────────── */}
					<div className="p-5 border-2 border-miku-teal/10 rounded-2xl bg-miku-teal/5">
						<h3 className="flex items-center mb-4 text-lg font-bold text-miku-teal">
							<Coffee className="w-5 h-5 mr-2" />
							Performance Settings
							<SparkleIcon className="text-miku-teal ml-2" size={14} />
						</h3>

						<div className="space-y-4">
							{/* Crawl Method — full-width selector */}
							<div>
								<label
									htmlFor="config-crawl-method"
									className="block mb-2 text-sm font-bold text-miku-text/70"
								>
									Crawl Method
								</label>
								<select
									id="config-crawl-method"
									value={options.crawlMethod}
									onChange={(e) => {
										const nextMethod = e.target.value;
										if (!isCrawlMethod(nextMethod)) {
											return;
										}

										onOptionsChange({
											...options,
											crawlMethod: nextMethod,
											saveMedia:
												nextMethod === "links" ? false : options.saveMedia,
										});
									}}
									className="w-full px-4 py-2 border-2 border-miku-pink/20 rounded-xl bg-white text-miku-text focus:border-miku-teal focus:outline-none shadow-sm"
								>
									<option value="links">
										Links — internal links, no saved media metadata
									</option>
									<option value="media">
										Media — internal links + saved media metadata
									</option>
									<option value="full">
										Full — internal + external links + saved media metadata
									</option>
								</select>
								<p className="mt-2 text-xs text-miku-text/50 font-medium">
									{crawlMethodDesc}
								</p>
							</div>

							{/* Crawl Depth — full-width with deep-crawl warning */}
							<div>
								<label
									htmlFor="config-crawl-depth"
									className="block mb-2 text-sm font-bold text-miku-text/70"
								>
									Crawl Depth
								</label>
								<input
									id="config-crawl-depth"
									type="number"
									value={options.crawlDepth}
									onChange={(e) => {
										const value = clampCrawlOption(
											"crawlDepth",
											e.target.value,
										);
										onOptionsChange({ ...options, crawlDepth: value });
									}}
									className="w-full px-4 py-2 border-2 border-miku-pink/20 rounded-xl bg-white text-miku-text focus:border-miku-teal focus:outline-none shadow-sm"
									min={CRAWL_OPTION_BOUNDS.crawlDepth.min}
									max={CRAWL_OPTION_BOUNDS.crawlDepth.max}
								/>
								<p className="mt-2 text-xs text-miku-text/50 font-medium">
									How many link-hops deep to crawl from the start URL
									{` (${CRAWL_OPTION_BOUNDS.crawlDepth.min}-${CRAWL_OPTION_BOUNDS.crawlDepth.max})`}
								</p>
								{options.crawlDepth >= CRAWL_OPTION_BOUNDS.crawlDepth.max && (
									<p className="mt-1.5 flex items-center gap-1.5 text-xs font-bold text-amber-600">
										<TriangleAlert className="w-3.5 h-3.5 shrink-0" />
										Deep crawls may take a while ✨
									</p>
								)}
							</div>

							{/* Max Pages + Per-Domain cap side-by-side */}
							<div className="grid grid-cols-2 gap-4">
								<div>
									<label
										htmlFor="config-max-pages"
										className="block mb-2 text-sm font-bold text-miku-text/70"
									>
										Max Pages (global)
									</label>
									<input
										id="config-max-pages"
										type="number"
										value={options.maxPages}
										onChange={(e) => {
											const value = clampCrawlOption(
												"maxPages",
												e.target.value,
											);
											onOptionsChange({ ...options, maxPages: value });
										}}
										className="w-full px-4 py-2 border-2 border-miku-pink/20 rounded-xl bg-white text-miku-text focus:border-miku-teal focus:outline-none shadow-sm"
										min={CRAWL_OPTION_BOUNDS.maxPages.min}
										max={CRAWL_OPTION_BOUNDS.maxPages.max}
									/>
									<p className="mt-2 text-xs text-miku-text/50 font-medium">
										Total pages to crawl across all domains
									</p>
								</div>

								<div>
									<label
										htmlFor="config-max-pages-domain"
										className="block mb-2 text-sm font-bold text-miku-text/70"
									>
										Per-Domain Limit
									</label>
									<input
										id="config-max-pages-domain"
										type="number"
										value={options.maxPagesPerDomain}
										onChange={(e) => {
											const value = clampCrawlOption(
												"maxPagesPerDomain",
												e.target.value,
											);
											onOptionsChange({
												...options,
												maxPagesPerDomain: value,
											});
										}}
										className="w-full px-4 py-2 border-2 border-miku-pink/20 rounded-xl bg-white text-miku-text focus:border-miku-teal focus:outline-none shadow-sm"
										min={CRAWL_OPTION_BOUNDS.maxPagesPerDomain.min}
										max={CRAWL_OPTION_BOUNDS.maxPagesPerDomain.max}
									/>
									<p className="mt-2 text-xs text-miku-text/50 font-medium">
										Pages per domain (0 = unlimited)
									</p>
								</div>
							</div>

							{/* Crawl Delay — full-width slider */}
							<div>
								<label
									htmlFor="config-crawl-delay"
									className="block mb-2 text-sm font-bold text-miku-text/70"
								>
									Crawl Delay
									<span className="ml-2 text-miku-teal font-black">
										{options.crawlDelay >= 1000
											? `${options.crawlDelay / 1000}s`
											: `${options.crawlDelay}ms`}
									</span>
								</label>
								<input
									id="config-crawl-delay"
									type="range"
									value={options.crawlDelay}
									min={CRAWL_OPTION_BOUNDS.crawlDelay.min}
									max={CRAWL_OPTION_BOUNDS.crawlDelay.max}
									step={CRAWL_OPTION_BOUNDS.crawlDelay.step}
									onChange={(e) =>
										onOptionsChange({
											...options,
											crawlDelay: Number(e.target.value),
										})
									}
									className="w-full h-2 bg-miku-pink/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-gradient-to-r [&::-webkit-slider-thumb]:from-miku-teal [&::-webkit-slider-thumb]:to-teal-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-md"
								/>
								<div className="flex justify-between mt-1 text-xs text-miku-text/40 font-medium">
									<span>250ms (fast)</span>
									<span>10s (polite)</span>
								</div>
								<p className="mt-1 text-xs text-miku-text/50 font-medium">
									Minimum wait between requests to the same domain
								</p>
							</div>

							{/* Concurrency + Retry side-by-side */}
							<div className="grid grid-cols-2 gap-4">
								<div>
									<label
										htmlFor="config-max-concurrent"
										className="block mb-2 text-sm font-bold text-miku-text/70"
									>
										Max Concurrent Requests
									</label>
									<input
										id="config-max-concurrent"
										type="number"
										value={options.maxConcurrentRequests}
										onChange={(e) => {
											const value = clampCrawlOption(
												"maxConcurrentRequests",
												e.target.value,
											);
											onOptionsChange({
												...options,
												maxConcurrentRequests: value,
											});
										}}
										className="w-full px-4 py-2 border-2 border-miku-pink/20 rounded-xl bg-white text-miku-text focus:border-miku-teal focus:outline-none shadow-sm"
										min={CRAWL_OPTION_BOUNDS.maxConcurrentRequests.min}
										max={CRAWL_OPTION_BOUNDS.maxConcurrentRequests.max}
									/>
									<p className="mt-2 text-xs text-miku-text/50 font-medium">
										Higher values crawl faster but may overload servers
									</p>
								</div>

								<div>
									<label
										htmlFor="config-retry-limit"
										className="block mb-2 text-sm font-bold text-miku-text/70"
									>
										Retry Limit
									</label>
									<input
										id="config-retry-limit"
										type="number"
										value={options.retryLimit}
										onChange={(e) => {
											const value = clampCrawlOption(
												"retryLimit",
												e.target.value,
											);
											onOptionsChange({ ...options, retryLimit: value });
										}}
										className="w-full px-4 py-2 border-2 border-miku-pink/20 rounded-xl bg-white text-miku-text focus:border-miku-teal focus:outline-none shadow-sm"
										min={CRAWL_OPTION_BOUNDS.retryLimit.min}
										max={CRAWL_OPTION_BOUNDS.retryLimit.max}
									/>
									<p className="mt-2 text-xs text-miku-text/50 font-medium">
										How many times to retry failed requests
									</p>
								</div>
							</div>
						</div>
					</div>

					{/* ── Content & Behavior ────────────────────────────────── */}
					<div className="p-5 border-2 border-miku-pink/10 rounded-2xl bg-miku-pink/5">
						<h3 className="flex items-center mb-4 text-lg font-bold text-miku-pink">
							<Database className="w-5 h-5 mr-2" />
							Content & Behavior
							<HeartIcon className="text-miku-pink ml-2" size={14} />
						</h3>

						<div className="grid grid-cols-1 gap-4">
							{[
								{
									id: "dynamic",
									label: "Use Dynamic Content (JS Rendering)",
									desc: "(Slower but handles SPAs better)",
									checked: options.dynamic,
								},
								{
									id: "respectRobots",
									label: "Respect robots.txt",
									desc: "(Be a polite crawler)",
									checked: options.respectRobots,
								},
								{
									id: "contentOnly",
									label: "Metadata Only",
									desc: "(Don't store full page content)",
									checked: options.contentOnly,
								},
								{
									id: "saveMedia",
									label: "Keep Media Metadata",
									desc: mediaRetentionDisabled
										? "(Requires Media or Full crawl method)"
										: "(Store extracted image/video/audio metadata in results)",
									checked: options.saveMedia,
									disabled: mediaRetentionDisabled,
								},
							].map((item) => (
								<div
									key={item.id}
									className={`flex items-start ${item.disabled ? "opacity-50" : ""}`}
								>
									<div className="flex items-center h-5">
										<input
											type="checkbox"
											id={item.id}
											checked={item.checked}
											disabled={item.disabled}
											onChange={(e) =>
												onOptionsChange({
													...options,
													[item.id]: e.target.checked,
												})
											}
											className="w-5 h-5 text-miku-teal border-2 border-miku-pink/30 rounded focus:ring-miku-teal focus:ring-offset-0 cursor-pointer accent-miku-teal"
										/>
									</div>
									<div className="ml-3 text-sm">
										<label
											htmlFor={item.id}
											className="font-bold text-miku-text cursor-pointer"
										>
											{item.label}
										</label>
										<p className="text-miku-text/50 font-medium text-xs mt-0.5">
											{item.desc}
										</p>
									</div>
								</div>
							))}
						</div>
					</div>

					<div className="flex justify-end mt-8 space-x-3">
						<button
							type="button"
							onClick={onClose}
							className="px-6 py-2.5 text-miku-text/60 font-bold hover:bg-miku-pink/10 rounded-xl transition-colors"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => {
								onSave();
								onClose();
							}}
							className="px-6 py-2.5 text-white font-bold bg-gradient-to-r from-miku-teal to-teal-400 rounded-xl shadow-lg shadow-miku-teal/30 hover:shadow-miku-teal/50 hover:scale-105 transition-all flex items-center gap-2"
						>
							Save Configuration
							<SparkleIcon className="text-white/80" size={14} />
						</button>
					</div>
				</div>
			</div>
		</dialog>
	);
}
