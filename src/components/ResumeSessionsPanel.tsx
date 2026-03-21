import { History, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { InterruptedSessionSummary } from "../api/crawls";
import { useFocusTrap } from "../hooks";
import { HeartIcon, SparkleIcon } from "./KawaiiIcons";

export type SessionSummary = InterruptedSessionSummary;

interface ResumeSessionsPanelProps {
	isOpen: boolean;
	sessions: SessionSummary[];
	isLoading: boolean;
	fetchError: string | null;
	deletingId: string | null;
	onRefresh: () => void;
	onDelete: (sessionId: string) => void;
	onClose: () => void;
	/**
	 * Called when the user confirms a session resume.
	 * The panel closes itself before calling this.
	 */
	onResume: (sessionId: string, target: string) => void;
}

/** Returns a human-readable relative time string, e.g. "3h ago". */
function formatRelativeTime(isoDate: string): string {
	const diffMs = Date.now() - new Date(isoDate).getTime();
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Shortens a URL to a readable length for display in the panel. */
function shortenUrl(url: string, maxLength = 45): string {
	try {
		const { hostname, pathname } = new URL(url);
		const display = `${hostname}${pathname}`;
		return display.length > maxLength
			? `${display.slice(0, maxLength)}…`
			: display;
	} catch {
		return url.length > maxLength ? `${url.slice(0, maxLength)}…` : url;
	}
}

export function ResumeSessionsPanel({
	isOpen,
	sessions,
	isLoading,
	fetchError,
	deletingId,
	onRefresh,
	onDelete,
	onClose,
	onResume,
}: Readonly<ResumeSessionsPanelProps>) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const { modalRef, initialFocusRef } = useFocusTrap<HTMLDivElement>({
		isOpen,
		onClose,
	});

	// Fetch whenever the panel opens
	useEffect(() => {
		if (isOpen) {
			onRefresh();
		}
	}, [isOpen, onRefresh]);

	// Keep the native <dialog> element in sync with the isOpen prop
	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (isOpen && !dialog.open) {
			dialog.showModal();
		} else if (!isOpen && dialog.open) {
			dialog.close();
		}
	}, [isOpen]);

	// ── Event handlers ─────────────────────────────────────────────────────────

	const handleResume = useCallback(
		(session: SessionSummary) => {
			onClose();
			onResume(session.id, session.target);
		},
		[onClose, onResume],
	);

	if (!isOpen) return null;

	return (
		<dialog
			ref={dialogRef}
			aria-labelledby="resume-dialog-title"
			className="fixed inset-0 z-50 flex items-center justify-center p-4 m-0 w-full h-full bg-transparent border-none backdrop:bg-black/20 backdrop:backdrop-blur-sm"
			onClose={onClose}
		>
			{/* Invisible backdrop hit-target */}
			<button
				type="button"
				className="absolute inset-0 w-full h-full bg-transparent border-none cursor-default"
				onClick={onClose}
				aria-label="Close dialog"
				tabIndex={-1}
			/>

			<div
				ref={modalRef}
				className="relative w-full max-w-xl p-6 bg-white rounded-3xl shadow-xl border-2 border-miku-teal/20 max-h-[90vh] overflow-y-auto animate-pop focus:outline-none"
			>
				{/* ── Header ─────────────────────────────────────────────────────── */}
				<div className="flex items-center justify-between mb-6">
					<h2
						id="resume-dialog-title"
						className="text-2xl font-black gradient-text tracking-tight flex items-center gap-2"
					>
						<History className="text-miku-teal w-5 h-5" />
						Resume Session
						<SparkleIcon className="text-miku-pink" size={20} />
					</h2>

					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={onRefresh}
							disabled={isLoading}
							className="p-2 rounded-full hover:bg-miku-teal/10 text-miku-text/40 hover:text-miku-teal transition-colors disabled:opacity-40"
							aria-label="Refresh session list"
							title="Refresh"
						>
							<RefreshCw
								className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
							/>
						</button>
						<button
							type="button"
							ref={initialFocusRef as React.RefObject<HTMLButtonElement>}
							onClick={onClose}
							className="p-2 rounded-full hover:bg-miku-pink/10 text-miku-text/40 hover:text-miku-pink transition-colors"
							aria-label="Close dialog"
						>
							✕
						</button>
					</div>
				</div>

				{/* ── Body ───────────────────────────────────────────────────────── */}
				<div className="space-y-3">
					{/* Error state */}
					{fetchError && (
						<div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm font-medium">
							{fetchError}
						</div>
					)}

					{/* Loading skeleton */}
					{isLoading && sessions.length === 0 && (
						<div className="space-y-2">
							{[1, 2].map((n) => (
								<div
									key={n}
									className="h-20 rounded-2xl bg-miku-teal/5 animate-pulse"
								/>
							))}
						</div>
					)}

					{/* Empty state */}
					{!isLoading && sessions.length === 0 && !fetchError && (
						<div className="py-12 text-center">
							<HeartIcon className="text-miku-pink/30 mx-auto mb-3" size={40} />
							<p className="text-miku-text/40 font-medium text-sm">
								No interrupted sessions found.
							</p>
							<p className="text-miku-text/30 text-xs mt-1">
								Sessions appear here when a crawl is interrupted mid-way.
							</p>
						</div>
					)}

					{/* Session list */}
					{sessions.map((session) => (
						<div
							key={session.id}
							className="p-4 rounded-2xl border-2 border-miku-teal/10 bg-miku-teal/5 hover:border-miku-teal/20 transition-all duration-200"
						>
							<div className="flex items-start justify-between gap-3">
								{/* Session info */}
								<div className="min-w-0 flex-1">
									<p
										className="font-bold text-miku-text text-sm truncate"
										title={session.target}
									>
										{shortenUrl(session.target)}
									</p>
									<div className="flex items-center gap-3 mt-1 flex-wrap">
										<span className="text-xs text-miku-text/50 font-medium">
											{session.pagesScanned} page
											{session.pagesScanned !== 1 ? "s" : ""} crawled
										</span>
										<span className="text-xs text-miku-text/40">·</span>
										<span className="text-xs text-miku-text/50 font-medium">
											Interrupted {formatRelativeTime(session.updatedAt)}
										</span>
									</div>
								</div>

								{/* Actions */}
								<div className="flex items-center gap-2 shrink-0">
									<button
										type="button"
										onClick={() => onDelete(session.id)}
										disabled={deletingId === session.id}
										className="p-2 rounded-xl text-miku-text/30 hover:text-rose-500 hover:bg-rose-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
										aria-label={`Delete session for ${session.target}`}
										title="Delete session"
									>
										<Trash2 className="w-4 h-4" />
									</button>
									<button
										type="button"
										onClick={() => handleResume(session)}
										disabled={deletingId === session.id}
										className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-miku-teal to-teal-400 text-white text-xs font-bold shadow-md shadow-miku-teal/20 hover:shadow-miku-teal/40 hover:scale-105 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
										aria-label={`Resume session for ${session.target}`}
									>
										<RotateCcw className="w-3.5 h-3.5" />
										Resume
									</button>
								</div>
							</div>
						</div>
					))}
				</div>

				{/* ── Footer note ────────────────────────────────────────────────── */}
				{sessions.length > 0 && (
					<p className="mt-4 text-xs text-miku-text/30 text-center font-medium">
						Resuming picks up from where the previous crawl left off ✨
					</p>
				)}
			</div>
		</dialog>
	);
}
