import { Download, ScrollText } from "lucide-react";
import { HeartIcon, SparkleIcon } from "./KawaiiIcons";

interface ActionButtonsProps {
	storedPageCount: number;
	setOpenExportDialog: (open: boolean) => void;
	showDetails: boolean;
	setShowDetails: (show: boolean) => void;
}

export function ActionButtons({
	storedPageCount,
	setOpenExportDialog,
	showDetails,
	setShowDetails,
}: Readonly<ActionButtonsProps>) {
	return (
		<div className="flex flex-wrap gap-2 py-1">
			<button
				type="button"
				className={`flex items-center justify-center px-5 py-2 rounded-lg border font-semibold text-xs uppercase tracking-wide transition-colors duration-200 ${
					storedPageCount === 0
						? "bg-white/45 border-miku-border text-miku-text/35 cursor-not-allowed"
						: "bg-white/70 border-miku-accent/20 text-miku-accent hover:bg-miku-accent/5"
				}`}
				onClick={() => setOpenExportDialog(true)}
				disabled={storedPageCount === 0}
			>
				<Download className="w-4 h-4 mr-1.5" />
				<span>Export Data</span>
				<HeartIcon className="hidden" size={12} />
				{storedPageCount > 0 && (
					<span className="ml-1.5 text-xs font-medium">{storedPageCount}</span>
				)}
			</button>

			<button
				type="button"
				className="flex items-center justify-center px-5 py-2 rounded-lg border border-miku-teal/35 bg-miku-teal/8 text-miku-teal-dark hover:bg-miku-teal/15 font-semibold text-xs uppercase tracking-wide transition-colors duration-200"
				onClick={() => setShowDetails(!showDetails)}
			>
				<ScrollText className="w-4 h-4 mr-1.5" />
				<span>{showDetails ? "Hide Stats" : "Show Stats"}</span>
				<SparkleIcon className="hidden" size={12} />
			</button>
		</div>
	);
}
