import { useState, type ChangeEvent } from 'react';
import { Filter, X } from 'lucide-react';
import { CrawledPage } from '../types';

// Display a crawled page with enhanced processed data
function CrawledPageDisplay({
  page,
  onClose,
}: {
  page: CrawledPage;
  onClose?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<'processed' | 'raw'>('processed');

  const processedData = page.processedData;
  const hasProcessedData = processedData && processedData.analysis;

  return (
    <div
      className={`py-2 border-b border-green-700 ${
        isExpanded ? 'bg-white/10' : ''
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="font-bold text-green-600 break-text">
          {page.title || page.url}
        </div>
        <div className="flex space-x-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="px-2 py-1 text-xs text-white bg-emerald-600 rounded hover:bg-emerald-700"
          >
            {isExpanded ? 'Hide' : 'View'}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="px-2 py-1 text-xs text-white bg-red-600 rounded hover:bg-red-700"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Enhanced metadata display */}
      <div className="mb-2 text-sm">
        {page.description && (
          <div className="text-gray-400 mb-1">{page.description}</div>
        )}
        {hasProcessedData && (
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-1 bg-blue-500 text-white rounded">
              {processedData.analysis.wordCount} words
            </span>
            <span className="px-2 py-1 bg-green-500 text-white rounded">
              {processedData.analysis.readingTime} min read
            </span>
            <span className="px-2 py-1 bg-purple-500 text-white rounded">
              Lang: {processedData.analysis.language}
            </span>
            <span className="px-2 py-1 bg-orange-500 text-white rounded">
              Quality: {processedData.qualityScore}/100
            </span>
            {processedData.media && processedData.media.length > 0 && (
              <span className="px-2 py-1 bg-pink-500 text-white rounded">
                {processedData.media.length} media
              </span>
            )}
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="mt-2">
          {hasProcessedData && (
            <div className="mb-3 flex space-x-2">
              <button
                onClick={() => setViewMode('processed')}
                className={`px-3 py-1 text-xs rounded ${
                  viewMode === 'processed'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                }`}
              >
                Processed Data
              </button>
              <button
                onClick={() => setViewMode('raw')}
                className={`px-3 py-1 text-xs rounded ${
                  viewMode === 'raw'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                }`}
              >
                Raw Content
              </button>
            </div>
          )}

          {viewMode === 'processed' && hasProcessedData ? (
            <div className="space-y-4">
              {/* Main Content */}
              {processedData.extractedData &&
                processedData.extractedData.mainContent && (
                  <div className="p-3 bg-gray-800 rounded">
                    <h4 className="text-sm font-semibold mb-2 text-emerald-300">
                      Main Content
                    </h4>
                    <div className="text-sm text-gray-300 max-h-32 overflow-y-auto">
                      {processedData.extractedData.mainContent.substring(
                        0,
                        500
                      )}
                      {processedData.extractedData.mainContent.length > 500 &&
                        '...'}
                    </div>
                  </div>
                )}

              {/* Keywords */}
              {processedData.analysis.keywords &&
                processedData.analysis.keywords.length > 0 && (
                  <div className="p-3 bg-gray-800 rounded">
                    <h4 className="text-sm font-semibold mb-2 text-emerald-300">
                      Top Keywords
                    </h4>
                    <div className="flex flex-wrap gap-1">
                      {processedData.analysis.keywords
                        .slice(0, 10)
                        .map((keyword, i) => (
                          <span
                            key={i}
                            className="px-2 py-1 text-xs bg-gray-600 text-white rounded"
                          >
                            {keyword.word} ({keyword.count})
                          </span>
                        ))}
                    </div>
                  </div>
                )}

              {/* Media */}
              {processedData.media && processedData.media.length > 0 && (
                <div className="p-3 bg-gray-800 rounded">
                  <h4 className="text-sm font-semibold mb-2 text-emerald-300">
                    Media ({processedData.media.length})
                  </h4>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {processedData.media.slice(0, 5).map((media, i) => (
                      <div key={i} className="text-xs text-gray-300">
                        <span className="text-blue-400">{media.type}</span>:{' '}
                        {media.url.substring(0, 60)}...
                      </div>
                    ))}
                    {processedData.media.length > 5 && (
                      <div className="text-xs text-gray-500">
                        ...and {processedData.media.length - 5} more
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Quality Issues */}
              {processedData.analysis.quality?.issues &&
                processedData.analysis.quality.issues.length > 0 && (
                  <div className="p-3 bg-gray-800 rounded">
                    <h4 className="text-sm font-semibold mb-2 text-emerald-300">
                      Quality Issues
                    </h4>
                    <div className="space-y-1">
                      {processedData.analysis.quality.issues.map((issue, i) => (
                        <div key={i} className="text-xs text-yellow-400">
                          • {issue}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          ) : (
            // Raw content view
            <div className="mt-2">
              {page.contentType?.includes('text/html') ? (
                <iframe
                  srcDoc={page.content}
                  title={page.url}
                  sandbox="allow-same-origin"
                  className="w-full h-96 bg-white rounded border border-gray-600"
                />
              ) : (
                <div className="p-4 overflow-auto text-sm bg-gray-800 rounded h-44">
                  <pre>{page.content}</pre>
                </div>
              )}
            </div>
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
  selectedPage,
  setSelectedPage,
  viewPageDetails,
  pageLimit,
}: CrawledPagesSectionProps) {
  const handleFilterChange = (e: ChangeEvent<HTMLInputElement>) => {
    onFilterChange(e.target.value);
  };

  return (
    <>
      {/* Filter input */}
      <div className="flex items-center mt-4 mb-2">
        <div className="flex items-center flex-1 px-3 bg-gray-100 rounded-lg dark:bg-gray-800">
          <Filter className="w-4 h-4 mr-2 text-gray-400" />
          <input
            type="text"
            value={filterText}
            onChange={handleFilterChange}
            placeholder="Filter crawled pages..."
            className="w-full py-2 bg-transparent border-none focus:outline-none focus:ring-0 text-sm"
          />
          {filterText && (
            <button
              onClick={() => {
                onClearFilter();
              }}
              className="p-1 text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="ml-2 text-sm text-gray-500">
          {isFilterActive
            ? `${displayedPages.length}/${crawledPages.length}`
            : crawledPages.length}{' '}
          pages
        </div>
      </div>

      {pageLimit && crawledPages.length >= pageLimit && (
        <div className="mt-1 text-xs text-gray-500">
          Showing latest {pageLimit} pages
        </div>
      )}

      {/* Crawled Pages Section */}
      <div className="p-4 font-mono text-sm bg-gray-900 rounded-lg mt-2 max-h-96 overflow-y-auto break-text">
        {selectedPage ? (
          <CrawledPageDisplay
            page={selectedPage}
            onClose={() => setSelectedPage(null)}
          />
        ) : !crawledPages.length ? (
          <div className="italic text-gray-500">
            {'> '} No pages crawled yet...
          </div>
        ) : isFilterActive ? (
          displayedPages.length ? (
            displayedPages.map((page, i) => (
              <div
                key={i}
                className="cursor-pointer"
                onClick={() => viewPageDetails(page)}
              >
                <CrawledPageDisplay page={page} />
              </div>
            ))
          ) : (
            <div className="italic text-gray-500">
              {'> '} No pages match your filter...
            </div>
          )
        ) : (
          crawledPages.map((page, i) => (
            <div
              key={i}
              className="cursor-pointer"
              onClick={() => viewPageDetails(page)}
            >
              <CrawledPageDisplay page={page} />
            </div>
          ))
        )}
      </div>
    </>
  );
}
