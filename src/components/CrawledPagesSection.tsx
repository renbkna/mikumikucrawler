import {
	AlertCircle,
	ChevronDown,
	ChevronUp,
	Code,
	ExternalLink,
	Filter,
	X,
} from "lucide-react";
import {
	type ChangeEvent,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { Virtuoso } from "react-virtuoso";
import { api } from "../api/client";
import type { CrawledPage } from "../types";
import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

const PageLimitFooter = memo(function PageLimitFooter({
	pageLimit,
}: {
	pageLimit: number;
}) {
	return (
		<div className="text-center text-xs font-bold text-miku-text/30 py-4 uppercase tracking-widest flex items-center justify-center gap-2">
			<NoteIcon className="text-miku-teal/50" size={10} />
			Showing latest {pageLimit} pages
			<NoteIcon className="text-miku-pink/50" size={10} />
		</div>
	);
});

const CrawledPageCard = memo(function CrawledPageCard({
	page,
}: {
	page: CrawledPage;
}) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [showSource, setShowSource] = useState(false);
	const [fetchedContent, setFetchedContent] = useState<string | null>(
		page.content || null,
	);
	const [isLoadingContent, setIsLoadingContent] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);

	const processedData = page.processedData;
	const hasProcessedData = processedData?.analysis;

	const handleToggleSource = async (e: React.MouseEvent) => {
		e.stopPropagation();

		if (showSource) {
			setShowSource(false);
			return;
		}

		setShowSource(true);

		if (fetchedContent) return;

		setIsLoadingContent(true);
		setFetchError(null);

		try {
			const { data, error } = await api.api
				.pages({ id: page.id })
				.content.get();

			if (error) {
				throw new Error(
					(error.value as { error?: string })?.error || "Failed to load",
				);
			}

			const response = data as { status: string; content?: string } | null;
			if (response?.status === "ok" && response.content) {
				setFetchedContent(response.content);
			} else {
				throw new Error("Invalid response format");
			}
		} catch (err) {
			setFetchError(
				err instanceof Error ? err.message : "Failed to fetch content",
			);
		} finally {
			setIsLoadingContent(false);
		}
	};

	return (
		<div className="cute-card p-4 transition-all duration-300 group mb-4 mx-2">
			<button
				type="button"
				className="flex items-start justify-between cursor-pointer w-full text-left bg-transparent border-none p-0"
				onClick={() => setIsExpanded(!isExpanded)}
				aria-expanded={isExpanded}
			>
				<div className="flex-1 min-w-0 pr-4">
					<h4 className="font-bold text-miku-text truncate group-hover:text-miku-pink transition-colors text-lg">
						{page.title || page.url}
					</h4>
					<a
						href={page.url}
						target="_blank"
						rel="noopener noreferrer"
						className="text-xs text-miku-text/50 hover:text-miku-teal flex items-center gap-1 mt-1 truncate font-medium"
						onClick={(e) => e.stopPropagation()}
					>
						{page.url}
						<ExternalLink className="w-3 h-3" />
					</a>
				</div>
				<span className="p-2 rounded-full bg-miku-pink/10 text-miku-pink/50 group-hover:text-miku-pink transition-colors">
					{isExpanded ? (
						<ChevronUp className="w-4 h-4" />
					) : (
						<ChevronDown className="w-4 h-4" />
					)}
				</span>
			</button>

			{hasProcessedData && !isExpanded && (
				<div className="flex flex-wrap gap-2 mt-4">
					<span className="cute-badge text-blue-500 border-blue-100 flex items-center gap-1">
						<NoteIcon className="text-blue-400" size={10} />
						{processedData.analysis.wordCount} words
					</span>
					<span className="cute-badge text-emerald-500 border-emerald-100 flex items-center gap-1">
						<SparkleIcon className="text-emerald-400" size={10} />
						{processedData.analysis.readingTime} min
					</span>
					<span className="cute-badge text-purple-500 border-purple-100 flex items-center gap-1">
						<HeartIcon className="text-purple-400" size={10} />
						{processedData.analysis.language}
					</span>
				</div>
			)}

			{isExpanded && (
				<div className="mt-4 pt-4 border-t-2 border-miku-pink/10 space-y-4 animate-pop">
					{page.description && (
						<p className="text-sm text-miku-text/70 italic bg-miku-teal/5 p-4 rounded-xl border border-miku-teal/10">
							"{page.description}"
						</p>
					)}

					<div className="flex gap-2">
						<button
							type="button"
							onClick={handleToggleSource}
							className="px-3 py-1.5 rounded-xl bg-miku-teal/10 text-miku-teal text-xs font-bold hover:bg-miku-teal/20 transition-colors flex items-center gap-1.5 border border-miku-teal/20"
							disabled={isLoadingContent}
						>
							<Code className="w-3 h-3" />
							{isLoadingContent
								? "Loading..."
								: showSource
									? "Hide Source"
									: "View Source"}
						</button>
					</div>

					{showSource && (
						<div className="bg-slate-800 rounded-xl p-4 overflow-hidden relative">
							<div className="flex items-center justify-between mb-2">
								<span className="text-xs font-bold text-slate-400">
									HTML Source
								</span>
								<span className="text-xs text-slate-500">
									{fetchedContent
										? `${fetchedContent.length} chars`
										: "0 chars"}
								</span>
							</div>

							{isLoadingContent ? (
								<div className="h-40 flex items-center justify-center text-slate-500 gap-2">
									<SparkleIcon
										className="animate-spin text-miku-teal"
										size={24}
									/>
									<span className="text-sm font-bold">Fetching content...</span>
								</div>
							) : fetchError ? (
								<div className="h-40 flex flex-col items-center justify-center text-rose-400 gap-2 p-4 text-center">
									<AlertCircle size={24} />
									<span className="text-sm font-bold">
										Error loading content
									</span>
									<span className="text-xs opacity-75">{fetchError}</span>
									<button
										type="button"
										onClick={(e) => {
											setFetchedContent(null);
											handleToggleSource(e);
										}}
										className="mt-2 px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 rounded text-xs text-rose-300 transition-colors"
									>
										Retry
									</button>
								</div>
							) : (
								<pre className="text-xs text-emerald-400 font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-60 custom-scrollbar">
									{fetchedContent || "No content available"}
								</pre>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
});

CrawledPageCard.displayName = "CrawledPageCard";

interface CrawledPagesSectionProps {
	crawledPages: CrawledPage[];
	displayedPages: CrawledPage[];
	filterText: string;
	onFilterChange: (text: string) => void;
	onClearFilter: () => void;
	pageLimit?: number;
}

/** Displays a searchable list of captured pages with virtualized scrolling for performance. */
export const CrawledPagesSection = memo(function CrawledPagesSection({
	crawledPages,
	displayedPages,
	filterText,
	onFilterChange,
	onClearFilter,
	pageLimit,
}: CrawledPagesSectionProps) {
	const [localFilter, setLocalFilter] = useState(filterText);

	useEffect(() => {
		setLocalFilter(filterText);
	}, [filterText]);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (localFilter !== filterText) {
				onFilterChange(localFilter);
			}
		}, 200);
		return () => clearTimeout(timer);
	}, [localFilter, filterText, onFilterChange]);

	const handleFilterChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
		setLocalFilter(e.target.value);
	}, []);

	const footerComponents = useMemo(
		() =>
			pageLimit && crawledPages.length >= pageLimit
				? { Footer: () => <PageLimitFooter pageLimit={pageLimit} /> }
				: undefined,
		[pageLimit, crawledPages.length],
	);

	return (
		<div className="space-y-4 h-full flex flex-col">
			<div className="bg-white rounded-2xl p-2 flex items-center gap-3 border-2 border-miku-pink/20 shrink-0">
				<div className="p-2 rounded-xl bg-miku-pink/10 text-miku-pink">
					<Filter className="w-5 h-5" />
				</div>
				<input
					type="text"
					value={localFilter}
					onChange={handleFilterChange}
					placeholder="Filter pages..."
					className="flex-1 bg-transparent border-none outline-none text-miku-text placeholder-miku-text/30 font-bold"
				/>
				{localFilter && (
					<button
						type="button"
						onClick={onClearFilter}
						className="p-2 rounded-full hover:bg-rose-50 text-miku-text/30 hover:text-rose-400 transition-colors"
					>
						<X className="w-4 h-4" />
					</button>
				)}
			</div>

			<div className="flex-1 overflow-hidden">
				{crawledPages.length === 0 ? (
					<div className="h-full flex flex-col items-center justify-center text-miku-text/40">
						<NoteIcon
							className="text-miku-teal/30 mb-4 animate-float"
							size={48}
						/>
						<p className="font-bold text-lg">No pages crawled yet...</p>
						<p className="text-sm mt-1 font-medium flex items-center gap-1">
							Start the Miku Beam to begin!{" "}
							<HeartIcon className="text-miku-pink" size={12} />
						</p>
					</div>
				) : displayedPages.length > 0 ? (
					<Virtuoso
						style={{ height: "100%" }}
						data={displayedPages}
						itemContent={(_index, page) => <CrawledPageCard page={page} />}
						{...(footerComponents ? { components: footerComponents } : {})}
					/>
				) : (
					<div className="text-center py-12 text-miku-text/40">
						<p className="font-medium">No pages match your filter</p>
					</div>
				)}
			</div>
		</div>
	);
});

CrawledPagesSection.displayName = "CrawledPagesSection";
