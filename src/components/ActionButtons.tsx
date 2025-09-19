import { Download, ScrollText } from "lucide-react";
import { CrawledPage } from "../types";

interface ActionButtonsProps {
  crawledPages: CrawledPage[];
  setOpenExportDialog: (open: boolean) => void;
  showDetails: boolean;
  setShowDetails: (show: boolean) => void;
}

export function ActionButtons({
  crawledPages,
  setOpenExportDialog,
  showDetails,
  setShowDetails
}: ActionButtonsProps) {
  return (
    <div className="flex flex-wrap gap-4 mb-4">
      {/* Export Data Button */}
      <button
        className={`flex items-center justify-center px-4 py-2 rounded-lg font-medium text-sm text-white transition-all duration-300 transform hover:scale-105 active:scale-95 shadow-md ${
          crawledPages.length === 0
            ? "bg-gradient-to-r from-gray-400 to-gray-500 cursor-not-allowed opacity-60"
            : "bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 shadow-purple-500/30"
        }`}
        onClick={() => setOpenExportDialog(true)}
        disabled={crawledPages.length === 0}
      >
        <Download className="w-4 h-4 mr-1.5" />
        <span>Export Data</span>
        {crawledPages.length > 0 && (
          <span className="ml-1.5 px-1.5 py-0.5 bg-white/20 rounded-full text-xs font-medium">
            {crawledPages.length}
          </span>
        )}
      </button>

      {/* Show/Hide Stats Button */}
      <button
        className="flex items-center justify-center px-4 py-2 rounded-lg font-medium text-sm text-white transition-all duration-300 transform hover:scale-105 active:scale-95 bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 shadow-md shadow-blue-500/30"
        onClick={() => setShowDetails(!showDetails)}
      >
        <ScrollText className="w-4 h-4 mr-1.5" />
        <span>{showDetails ? "Hide Stats" : "Show Stats"}</span>
        <span className="ml-1.5 text-xs">
        </span>
      </button>
    </div>
  );
}
