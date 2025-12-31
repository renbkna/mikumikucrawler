import { Download, ScrollText } from "lucide-react";
import type { CrawledPage } from "../types";
import { HeartIcon, SparkleIcon } from "./KawaiiIcons";

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
	setShowDetails,
}: Readonly<ActionButtonsProps>) {
	return (
		<div className="flex flex-wrap gap-4 mb-4">
			<button
				type="button"
				className={`flex items-center justify-center px-5 py-2.5 rounded-full font-bold text-sm text-white transition-all duration-300 transform hover:scale-105 active:scale-95 ${
					crawledPages.length === 0
						? "bg-gray-300 cursor-not-allowed opacity-60"
						: "bg-gradient-to-r from-purple-400 to-miku-pink shadow-lg shadow-miku-pink/20"
				}`}
				onClick={() => setOpenExportDialog(true)}
				disabled={crawledPages.length === 0}
			>
				<Download className="w-4 h-4 mr-1.5" />
				<span>Export Data</span>
				<HeartIcon className="text-white/80 ml-1" size={12} />
				{crawledPages.length > 0 && (
					<span className="ml-1.5 px-1.5 py-0.5 bg-white/30 rounded-full text-xs font-medium">
						{crawledPages.length}
					</span>
				)}
			</button>

			<button
				type="button"
				className="flex items-center justify-center px-5 py-2.5 rounded-full font-bold text-sm text-white transition-all duration-300 transform hover:scale-105 active:scale-95 bg-gradient-to-r from-miku-teal to-teal-400 shadow-lg shadow-miku-teal/20"
				onClick={() => setShowDetails(!showDetails)}
			>
				<ScrollText className="w-4 h-4 mr-1.5" />
				<span>{showDetails ? "Hide Stats" : "Show Stats"}</span>
				<SparkleIcon className="text-white/80 ml-1" size={12} />
			</button>
		</div>
	);
}
