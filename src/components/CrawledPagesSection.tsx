import { AlertCircle, ChevronDown, ChevronUp, Code, ExternalLink, Filter, X } from "lucide-react";
import { type ChangeEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import type { CrawledPage } from "../../shared/contracts/pageData.js";
import { createPageContentRequestSignal, getPageContent } from "../api/pages";
import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

const PageLimitFooter = memo(function PageLimitFooter({
	pageLimit,
}: {
	pageLimit: number | undefined;
}) {
	if (pageLimit === undefined) {
		return null;
	}
	return (
		<div className="text-center text-xs font-bold text-miku-text/30 py-4 uppercase tracking-widest flex items-center justify-center gap-2">
			<NoteIcon className="text-miku-teal/50" size={10} />
			Showing latest {pageLimit} pages
			<NoteIcon className="text-miku-pink/50" size={10} />
		</div>
	);
});

const VirtuosoFooter = ({ context }: { context?: { pageLimit?: number; showFooter: boolean } }) => {
	if (!context?.showFooter || !context.pageLimit) return null;
	return <PageLimitFooter pageLimit={context.pageLimit} />;
};

type PageContentState = { type: "unloaded" } | { type: "loaded"; content: string | null };

const CrawledPageCard = memo(function CrawledPageCard({ page }: { page: CrawledPage }) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [showSource, setShowSource] = useState(false);
	const [contentState, setContentState] = useState<PageContentState>(() =>
		page.content === undefined ? { type: "unloaded" } : { type: "loaded", content: page.content },
	);
	const [isLoadingContent, setIsLoadingContent] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const contentRequestRef = useRef<AbortController | null>(null);

	useEffect(
		() => () => {
			contentRequestRef.current?.abort();
		},
		[],
	);

	const processedData = page.processedData;
	const hasProcessedData = processedData?.analysis;

	const fetchPageContent = async () => {
		setIsLoadingContent(true);
		setFetchError(null);
		contentRequestRef.current?.abort();
		const lifetimeController = new AbortController();
		contentRequestRef.current = lifetimeController;
		const requestSignal = createPageContentRequestSignal(lifetimeController.signal);

		try {
			const result = await getPageContent(page.id, requestSignal);
			if (lifetimeController.signal.aborted) {
				return;
			}
			if (result.ok) {
				setContentState({ type: "loaded", content: result.data.content });
			} else {
				throw new Error(result.error);
			}
		} catch (err) {
			if (lifetimeController.signal.aborted) {
				return;
			}

			setFetchError(
				requestSignal.aborted
					? "Page content request timed out"
					: err instanceof Error
						? err.message
						: "Failed to fetch content",
			);
		} finally {
			if (!lifetimeController.signal.aborted) {
				setIsLoadingContent(false);
			}
			if (contentRequestRef.current === lifetimeController) {
				contentRequestRef.current = null;
			}
		}
	};

	const handleToggleSource = async (e: React.MouseEvent) => {
		e.stopPropagation();

		if (showSource) {
			setShowSource(false);
			return;
		}

		setShowSource(true);
		if (contentState.type === "unloaded") {
			await fetchPageContent();
		}
	};

	const sourceButtonText = isLoadingContent
		? "Loading..."
		: showSource
			? "Hide Source"
			: "View Source";
	const sourceContent =
		contentState.type === "loaded" && contentState.content !== null
			? contentState.content
			: "(no content stored - metadata-only mode)";
	const analysis = processedData?.analysis;
	const hasSummaryMetrics =
		typeof analysis?.wordCount === "number" ||
		typeof analysis?.readingTime === "number" ||
		typeof analysis?.language === "string";

	const renderSourceContent = () => {
		if (isLoadingContent) {
			return (
				<div className="h-40 flex items-center justify-center text-slate-500 gap-2">
					<SparkleIcon className="animate-spin text-miku-teal" size={24} />
					<span className="text-sm font-bold">Fetching content...</span>
				</div>
			);
		}

		if (fetchError) {
			return (
				<div className="h-40 flex flex-col items-center justify-center text-rose-400 gap-2 p-4 text-center">
					<AlertCircle size={24} />
					<span className="text-sm font-bold">Error loading content</span>
					<span className="text-xs opacity-75">{fetchError}</span>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							setContentState({ type: "unloaded" });
							void fetchPageContent();
						}}
						className="mt-2 px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 rounded text-xs text-rose-300 transition-colors"
					>
						Retry
					</button>
				</div>
			);
		}

		return (
			<pre className="text-xs text-emerald-400 font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-60 custom-scrollbar">
				{sourceContent}
			</pre>
		);
	};

	return (
		<div className="cute-card p-4 transition-all duration-300 group mb-4 mx-2">
			<button
				type="button"
				className="flex items-start justify-between cursor-pointer w-full text-left bg-transparent border-none p-0"
				onClick={() => setIsExpanded(!isExpanded)}
				aria-expanded={isExpanded}
			>
				<h4 className="flex-1 min-w-0 pr-4 font-bold text-miku-text truncate group-hover:text-miku-pink transition-colors text-lg">
					{page.title || page.url}
				</h4>
				<span className="p-2 rounded-full bg-miku-pink/10 text-miku-pink/50 group-hover:text-miku-pink transition-colors">
					{isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
				</span>
			</button>
			<a
				href={page.url}
				target="_blank"
				rel="noopener noreferrer"
				className="text-xs text-miku-text/50 hover:text-miku-teal flex items-center gap-1 mt-1 truncate font-medium"
			>
				{page.url}
				<ExternalLink className="w-3 h-3" />
			</a>

			{hasProcessedData && hasSummaryMetrics && !isExpanded && (
				<div className="flex flex-wrap gap-2 mt-4">
					{typeof analysis?.wordCount === "number" && (
						<span className="cute-badge text-blue-500 border-blue-100 flex items-center gap-1">
							<NoteIcon className="text-blue-400" size={10} />
							{analysis.wordCount} words
						</span>
					)}
					{typeof analysis?.readingTime === "number" && (
						<span className="cute-badge text-emerald-500 border-emerald-100 flex items-center gap-1">
							<SparkleIcon className="text-emerald-400" size={10} />
							{analysis.readingTime} min
						</span>
					)}
					{typeof analysis?.language === "string" && (
						<span className="cute-badge text-purple-500 border-purple-100 flex items-center gap-1">
							<HeartIcon className="text-purple-400" size={10} />
							{analysis.language}
						</span>
					)}
				</div>
			)}

			{isExpanded && (
				<div className="mt-4 pt-4 border-t-2 border-miku-pink/10 space-y-4 animate-pop">
					{page.description && (
						<p className="text-sm text-miku-text/70 italic bg-miku-teal/5 p-4 rounded-xl border border-miku-teal/10">
							"{page.description}"
						</p>
					)}

					{processedData?.errors && processedData.errors.length > 0 && (
						<div className="bg-rose-50 border border-rose-100 rounded-xl p-3 space-y-2">
							<div className="flex items-center gap-2 text-rose-500 font-bold text-xs uppercase tracking-wide">
								<AlertCircle size={14} />
								Processing Errors
							</div>
							<ul className="space-y-1">
								{processedData.errors.map((error) => (
									<li
										key={`${error.type}-${error.message}-${error.timestamp ?? "no-timestamp"}`}
										className="text-xs text-rose-600 font-medium"
									>
										{error.message}
									</li>
								))}
							</ul>
						</div>
					)}

					<div className="flex gap-2">
						<button
							type="button"
							onClick={(event) => {
								void handleToggleSource(event);
							}}
							className="px-3 py-1.5 rounded-xl bg-miku-teal/10 text-miku-teal text-xs font-bold hover:bg-miku-teal/20 transition-colors flex items-center gap-1.5 border border-miku-teal/20"
							disabled={isLoadingContent}
						>
							<Code className="w-3 h-3" />
							{sourceButtonText}
						</button>
					</div>

					{showSource && (
						<div className="bg-slate-800 rounded-xl p-4 overflow-hidden relative">
							<div className="flex items-center justify-between mb-2">
								<span className="text-xs font-bold text-slate-400">HTML Source</span>
								<span className="text-xs text-slate-500">
									{contentState.type === "loaded" && contentState.content !== null
										? `${contentState.content.length} chars`
										: "0 chars"}
								</span>
							</div>

							{renderSourceContent()}
						</div>
					)}
				</div>
			)}
		</div>
	);
});

CrawledPageCard.displayName = "CrawledPageCard";

const renderPageItem = (_index: number, page: CrawledPage) => <CrawledPageCard page={page} />;

const getPageItemKey = (_index: number, page: CrawledPage) => page.id;

interface CrawledPagesSectionProps {
	crawledPages: CrawledPage[];
	displayedPages: CrawledPage[];
	searchQuery: string;
	onSearchChange: (text: string) => void;
	onClearSearch: () => void;
	searchResultCount: number;
	isSearching: boolean;
	searchError: string | null;
	pageLimit?: number;
}

export const CrawledPagesSection = memo(function CrawledPagesSection({
	crawledPages,
	displayedPages,
	searchQuery,
	onSearchChange,
	onClearSearch,
	searchResultCount,
	isSearching,
	searchError,
	pageLimit,
}: Readonly<CrawledPagesSectionProps>) {
	const [localQuery, setLocalQuery] = useState(searchQuery);

	useEffect(() => {
		setLocalQuery(searchQuery);
	}, [searchQuery]);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (localQuery !== searchQuery) {
				onSearchChange(localQuery);
			}
		}, 200);
		return () => clearTimeout(timer);
	}, [localQuery, onSearchChange, searchQuery]);

	const handleSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
		setLocalQuery(e.target.value);
	}, []);
	const handleClearSearch = useCallback(() => {
		setLocalQuery("");
		onClearSearch();
	}, [onClearSearch]);

	const virtuosoComponents = useMemo(
		() => ({
			Footer: VirtuosoFooter,
		}),
		[],
	);

	const listContent = useMemo(() => {
		const hasSearchQuery = searchQuery.trim().length > 0;
		if (isSearching && displayedPages.length === 0) {
			return (
				<div className="h-full flex items-center justify-center text-miku-text/40">
					<SparkleIcon className="animate-spin text-miku-teal mr-2" size={20} />
					<p className="font-bold">Searching stored page content...</p>
				</div>
			);
		}

		if (searchError) {
			return (
				<div className="h-full flex flex-col items-center justify-center text-rose-400 gap-2 p-4 text-center">
					<AlertCircle size={24} />
					<p className="font-bold">Stored-page search failed</p>
					<p className="text-xs opacity-75">{searchError}</p>
				</div>
			);
		}

		if (!hasSearchQuery && crawledPages.length === 0) {
			return (
				<div className="h-full flex flex-col items-center justify-center text-miku-text/40">
					<NoteIcon className="text-miku-pink/45 mb-3" size={34} />
					<p className="font-semibold text-base">No pages crawled yet...</p>
					<p className="text-xs mt-1 font-medium flex items-center gap-1">
						Start the Miku Beam to begin! <HeartIcon className="text-miku-pink" size={12} />
					</p>
				</div>
			);
		}

		if (displayedPages.length > 0) {
			const showFooter = !hasSearchQuery && !!(pageLimit && crawledPages.length >= pageLimit);
			return (
				<div className="h-full flex flex-col">
					{hasSearchQuery && (
						<p className="px-2 pb-2 text-xs font-bold text-miku-text/40">
							Showing {displayedPages.length} of {searchResultCount} stored-page match
							{searchResultCount === 1 ? "" : "es"}
						</p>
					)}
					<div className="flex-1 min-h-0">
						<Virtuoso
							style={{ height: "100%" }}
							data={displayedPages}
							computeItemKey={getPageItemKey}
							context={{ pageLimit: hasSearchQuery ? undefined : pageLimit, showFooter }}
							itemContent={renderPageItem}
							components={virtuosoComponents}
						/>
					</div>
				</div>
			);
		}

		return (
			<div className="text-center py-12 text-miku-text/40">
				<p className="font-medium">No stored pages match this search</p>
			</div>
		);
	}, [
		crawledPages.length,
		displayedPages,
		isSearching,
		pageLimit,
		searchError,
		searchQuery,
		searchResultCount,
		virtuosoComponents,
	]);

	return (
		<div className="space-y-3 h-full flex flex-col">
			<p className="hidden">Search uses the durable full-text index for the active crawl.</p>
			<div className="bg-white/60 rounded-xl p-1.5 flex items-center gap-2 border border-miku-accent/15 shrink-0">
				<div className="p-1.5 text-miku-accent/50">
					<Filter className="w-4 h-4" />
				</div>
				<input
					type="text"
					value={localQuery}
					onChange={handleSearchChange}
					placeholder="Search stored page content..."
					className="flex-1 bg-transparent border-none outline-none text-miku-text placeholder-miku-text/30 font-medium"
				/>
				{localQuery && (
					<button
						type="button"
						onClick={handleClearSearch}
						aria-label="Clear page search"
						title="Clear search"
						className="p-2 rounded-full hover:bg-rose-50 text-miku-text/30 hover:text-rose-400 transition-colors"
					>
						<X className="w-4 h-4" />
					</button>
				)}
			</div>

			<div className="flex-1 overflow-hidden">{listContent}</div>
		</div>
	);
});

CrawledPagesSection.displayName = "CrawledPagesSection";
