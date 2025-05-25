import { useState } from "react";
import { Filter, X } from "lucide-react";
import { CrawledPage } from "../types";

// Display a crawled page inside an iframe with better controls
function CrawledPageDisplay({ page, onClose }: { page: CrawledPage, onClose?: () => void }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={`py-2 border-b border-green-700 ${isExpanded ? 'bg-white/10' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="font-bold break-text">{page.title || page.url}</div>
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

      {page.description && (
        <div className="mb-2 text-sm text-gray-400">{page.description}</div>
      )}

      {isExpanded && (
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
  );
}

interface CrawledPagesSectionProps {
  crawledPages: CrawledPage[];
  filteredPages: CrawledPage[];
  filterText: string;
  setFilterText: (text: string) => void;
  isFilterActive: boolean;
  setIsFilterActive: (active: boolean) => void;
  selectedPage: CrawledPage | null;
  setSelectedPage: (page: CrawledPage | null) => void;
  viewPageDetails: (page: CrawledPage) => void;
}

export function CrawledPagesSection({
  crawledPages,
  filteredPages,
  filterText,
  setFilterText,
  isFilterActive,
  setIsFilterActive,
  selectedPage,
  setSelectedPage,
  viewPageDetails
}: CrawledPagesSectionProps) {
  const handleFilterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const filter = e.target.value;
    setFilterText(filter);
    setIsFilterActive(!!filter.trim());
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
                setFilterText('');
                setIsFilterActive(false);
              }}
              className="p-1 text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="ml-2 text-sm text-gray-500">
          {isFilterActive
            ? `${filteredPages.length}/${crawledPages.length}`
            : crawledPages.length} pages
        </div>
      </div>

      {/* Crawled Pages Section */}
      <div className="p-4 font-mono text-sm bg-gray-900 rounded-lg mt-2 max-h-96 overflow-y-auto break-text">
        {selectedPage ? (
          <CrawledPageDisplay
            page={selectedPage}
            onClose={() => setSelectedPage(null)}
          />
        ) : !crawledPages.length ? (
          <div className="italic text-gray-500">{"> "} No pages crawled yet...</div>
        ) : isFilterActive ? (
          filteredPages.length ? (
            filteredPages.map((page, i) => (
              <div key={i} className="cursor-pointer" onClick={() => viewPageDetails(page)}>
                <CrawledPageDisplay page={page} />
              </div>
            ))
          ) : (
            <div className="italic text-gray-500">{"> "} No pages match your filter...</div>
          )
        ) : (
          crawledPages.map((page, i) => (
            <div key={i} className="cursor-pointer" onClick={() => viewPageDetails(page)}>
              <CrawledPageDisplay page={page} />
            </div>
          ))
        )}
      </div>
    </>
  );
}
