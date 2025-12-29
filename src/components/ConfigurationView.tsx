import { Coffee, Database } from "lucide-react";
import { useFocusTrap } from "../hooks";
import type { CrawlOptions } from "../types";
import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface ConfigurationViewProps {
	isOpen: boolean;
	onClose: () => void;
	options: CrawlOptions;
	onOptionsChange: (options: CrawlOptions) => void;
	onSave: () => void;
}

/** Provides an interface for adjusting crawl depth, concurrency, and behavioral policies. */
export function ConfigurationView({
	isOpen,
	onClose,
	options,
	onOptionsChange,
	onSave,
}: Readonly<ConfigurationViewProps>) {
	const { modalRef, initialFocusRef } = useFocusTrap<HTMLDivElement>({
		isOpen,
		onClose,
	});

	if (!isOpen) return null;

	const handleBackdropClick = (e: React.MouseEvent) => {
		if (e.target === e.currentTarget) {
			onClose();
		}
	};

	return (
		<dialog
			open={isOpen}
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm m-0 p-0 w-full h-full max-w-none max-h-none border-none bg-transparent"
			onClick={handleBackdropClick}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
			aria-labelledby="config-dialog-title"
		>
			<div
				ref={modalRef}
				className="w-full max-w-xl p-6 bg-white rounded-3xl shadow-xl border-2 border-miku-pink/20 max-h-[90vh] overflow-y-auto animate-pop"
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
						ref={initialFocusRef as React.RefObject<HTMLButtonElement>}
						onClick={onClose}
						className="p-2 rounded-full hover:bg-miku-pink/10 text-miku-text/40 hover:text-miku-pink transition-colors"
						aria-label="Close configuration dialog"
					>
						✕
					</button>
				</div>

				<div className="space-y-6">
					<div className="p-5 border-2 border-miku-teal/10 rounded-2xl bg-miku-teal/5">
						<h3 className="flex items-center mb-4 text-lg font-bold text-miku-teal">
							<Coffee className="w-5 h-5 mr-2" />
							Performance Settings
							<SparkleIcon className="text-miku-teal ml-2" size={14} />
						</h3>

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
										const value = Math.min(
											10,
											Math.max(1, Number(e.target.value) || 1),
										);
										onOptionsChange({
											...options,
											maxConcurrentRequests: value,
										});
									}}
									className="w-full px-4 py-2 border-2 border-miku-pink/20 rounded-xl bg-white text-miku-text focus:border-miku-teal focus:outline-none shadow-sm"
									min="1"
									max="10"
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
										const value = Math.min(
											5,
											Math.max(0, Number(e.target.value) || 0),
										);
										onOptionsChange({ ...options, retryLimit: value });
									}}
									className="w-full px-4 py-2 border-2 border-miku-pink/20 rounded-xl bg-white text-miku-text focus:border-miku-teal focus:outline-none shadow-sm"
									min="0"
									max="5"
								/>
								<p className="mt-2 text-xs text-miku-text/50 font-medium">
									How many times to retry failed requests
								</p>
							</div>
						</div>
					</div>

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
									label: "Process Media Files",
									desc: "(Images, PDFs, etc.)",
									checked: options.saveMedia,
								},
							].map((item) => (
								<div key={item.id} className="flex items-start">
									<div className="flex items-center h-5">
										<input
											type="checkbox"
											id={item.id}
											checked={item.checked}
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
