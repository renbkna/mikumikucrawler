import { AlertCircle, ChevronDown, ChevronUp, Code, ExternalLink, FileText, Filter, Image, X } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';
import { CrawledPage } from '../types';

function CrawledPageCard({ page }: { page: CrawledPage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const processedData = page.processedData;
  const hasProcessedData = processedData && processedData.analysis;

  return (
    <div className="bg-white/60 border-2 border-white rounded-2xl p-4 transition-all duration-300 hover:shadow-lg hover:border-miku-pink/30 group hover:-translate-y-0.5">
      <div
        className="flex items-start justify-between cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex-1 min-w-0 pr-4">
          <h4 className="font-bold text-slate-700 truncate group-hover:text-miku-pink transition-colors text-lg">
            {page.title || page.url}
          </h4>
          <a
            href={page.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-400 hover:text-miku-teal flex items-center gap-1 mt-1 truncate font-medium"
            onClick={(e) => e.stopPropagation()}
          >
            {page.url}
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <button className="p-2 rounded-full bg-white text-slate-300 group-hover:text-miku-pink transition-colors shadow-sm">
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {/* Quick Stats Tags */}
      {hasProcessedData && !isExpanded && (
        <div className="flex flex-wrap gap-2 mt-4">
          <span className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-500 text-xs font-bold border border-blue-100">
            {processedData.analysis.wordCount} words
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-500 text-xs font-bold border border-emerald-100">
            {processedData.analysis.readingTime} min
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-purple-50 text-purple-500 text-xs font-bold border border-purple-100">
            {processedData.analysis.language}
          </span>
        </div>
      )}

      {/* Expanded Content */}
      {isExpanded && (
        <div className="mt-4 pt-4 border-t-2 border-slate-50 space-y-4 animate-pop">
          {page.description && (
            <p className="text-sm text-slate-600 italic bg-miku-bg/50 p-4 rounded-xl border border-miku-bg">
              "{page.description}"
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2">
             <button
                onClick={(e) => {
                    e.stopPropagation();
                    setShowSource(!showSource);
                }}
                className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-500 text-xs font-bold hover:bg-miku-teal hover:text-white transition-colors flex items-center gap-1.5"
             >
                <Code className="w-3 h-3" />
                {showSource ? 'Hide Source' : 'View Source'}
             </button>
          </div>

          {showSource && (
            <div className="bg-slate-800 rounded-xl p-4 overflow-hidden">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-slate-400">HTML Source</span>
                    <span className="text-xs text-slate-500">{page.content?.length || 0} chars</span>
                </div>
                <pre className="text-xs text-emerald-400 font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-60 scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent">
                    {page.content || 'No content available'}
                </pre>
            </div>
          )}

          {hasProcessedData ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Keywords */}
              <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm">
                <h5 className="text-xs font-bold text-slate-400 uppercase mb-3 flex items-center gap-1.5">
                  <FileText className="w-3 h-3" /> Keywords
                </h5>
                <div className="flex flex-wrap gap-1.5">
                  {processedData.analysis.keywords?.slice(0, 8).map((k, i) => (
                    <span key={i} className="px-2 py-1 rounded-md bg-slate-50 text-slate-500 text-xs font-medium border border-slate-100">
                      {k.word}
                    </span>
                  ))}
                </div>
              </div>

              {/* Media */}
              <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm">
                <h5 className="text-xs font-bold text-slate-400 uppercase mb-3 flex items-center gap-1.5">
                  <Image className="w-3 h-3" /> Media
                </h5>
                <div className="text-sm font-bold text-slate-600">
                  Found <span className="text-miku-teal">{processedData.media?.length || 0}</span> media files
                </div>
              </div>

              {/* Quality Issues */}
              {processedData.analysis.quality?.issues?.length > 0 && (
                <div className="col-span-full bg-rose-50/50 rounded-xl p-4 border border-rose-100">
                  <h5 className="text-xs font-bold text-rose-400 uppercase mb-3 flex items-center gap-1.5">
                    <AlertCircle className="w-3 h-3" /> Quality Check
                  </h5>
                  <ul className="space-y-2">
                    {processedData.analysis.quality.issues.map((issue, i) => (
                      <li key={i} className="text-xs text-rose-600 flex items-start gap-2 font-medium">
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0"></span>
                        {issue}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            !showSource && (
                <div className="text-sm text-slate-400 text-center py-4 italic">
                No processed data available
                </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

interface CrawledPagesSectionProps {
  crawledPages: CrawledPage[];
  displayedPages: CrawledPage[];
  filterText: string;
  onFilterChange: (text: string) => void;
  onClearFilter: () => void;
  isFilterActive: boolean;
  selectedPage: CrawledPage | null;
  setSelectedPage: (page: CrawledPage | null) => void;
  viewPageDetails: (page: CrawledPage) => void;
  pageLimit?: number;
}

export function CrawledPagesSection({
  crawledPages,
  displayedPages,
  filterText,
  onFilterChange,
  onClearFilter,
  isFilterActive,
  pageLimit,
}: CrawledPagesSectionProps) {
  const handleFilterChange = (e: ChangeEvent<HTMLInputElement>) => {
    onFilterChange(e.target.value);
  };

  return (
    <div className="space-y-4 h-full flex flex-col">
      {/* Filter Bar */}
      <div className="bg-white rounded-2xl p-2 flex items-center gap-3 border-2 border-slate-50 shadow-sm">
        <div className="p-2 rounded-xl bg-miku-pink/10 text-miku-pink">
          <Filter className="w-5 h-5" />
        </div>
        <input
          type="text"
          value={filterText}
          onChange={handleFilterChange}
          placeholder="Filter pages..."
          className="flex-1 bg-transparent border-none outline-none text-slate-700 placeholder-slate-300 font-bold"
        />
        {filterText && (
          <button
            onClick={onClearFilter}
            className="p-2 rounded-full hover:bg-slate-50 text-slate-300 hover:text-slate-500 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Pages Grid */}
      <div className="flex-1 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent pb-4 space-y-4">
        {!crawledPages.length ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-300">
            <div className="text-5xl mb-4 opacity-50 animate-float">🕸️</div>
            <p className="font-bold text-lg">No pages crawled yet...</p>
            <p className="text-sm mt-1 font-medium">Start the Miku Beam to begin!</p>
          </div>
        ) : displayedPages.length ? (
          displayedPages.map((page, i) => (
            <CrawledPageCard key={i} page={page} />
          ))
        ) : (
          <div className="text-center py-12 text-slate-400">
            <p className="font-medium">No pages match your filter</p>
          </div>
        )}

        {pageLimit && crawledPages.length >= pageLimit && (
          <div className="text-center text-xs font-bold text-slate-300 py-4 uppercase tracking-widest">
            Showing latest {pageLimit} pages
          </div>
        )}
      </div>
    </div>
  );
}
