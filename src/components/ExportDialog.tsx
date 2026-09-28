import { Download, Music2 } from "lucide-react";
import type { CrawlExportFormat } from "../../shared/contracts/index.js";
import { Modal } from "./Modal";

interface ExportDialogProps {
	onClose: () => void;
	onExport: (format: CrawlExportFormat) => void;
}

export function ExportDialog({ onClose, onExport }: Readonly<ExportDialogProps>) {
	return (
		<Modal labelledBy="export-dialog-title" size="md" onClose={onClose}>
			<h2
				id="export-dialog-title"
				className="mb-4 text-xl font-bold gradient-text flex items-center gap-2"
			>
				<Music2 className="text-miku-teal" size={18} />
				Export Crawled Data
			</h2>

			<div className="space-y-3">
				<button
					type="button"
					onClick={() => {
						onExport("json");
						onClose();
					}}
					className="flex items-center justify-between w-full p-4 border border-miku-teal/25 rounded-xl bg-white/65 hover:bg-miku-teal/5 hover:border-miku-teal/40 focus:ring-2 focus:ring-miku-teal/20 focus:outline-none transition-colors group"
				>
					<span className="font-bold text-miku-text flex items-center gap-2">JSON Format</span>
					<Download className="w-5 h-5 text-miku-teal group-hover:scale-110 transition-transform" />
				</button>

				<button
					type="button"
					onClick={() => {
						onExport("csv");
						onClose();
					}}
					className="flex items-center justify-between w-full p-4 border border-miku-pink/25 rounded-xl bg-white/65 hover:bg-miku-pink/5 hover:border-miku-pink/40 focus:ring-2 focus:ring-miku-pink/20 focus:outline-none transition-colors group"
				>
					<span className="font-bold text-miku-text flex items-center gap-2">CSV Format</span>
					<Download className="w-5 h-5 text-miku-pink group-hover:scale-110 transition-transform" />
				</button>
			</div>

			<div className="flex justify-end mt-6">
				<button
					type="button"
					onClick={onClose}
					className="px-6 py-2.5 text-miku-text/60 font-bold hover:bg-miku-pink/10 rounded-xl transition-colors"
				>
					Cancel
				</button>
			</div>
		</Modal>
	);
}
