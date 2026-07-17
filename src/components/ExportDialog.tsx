import { Download } from "lucide-react";
import { useDialogModal } from "../hooks/useDialogModal";
import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface ExportDialogProps {
	isOpen: boolean;
	onClose: () => void;
	onExport: (format: string) => void;
}

export function ExportDialog({ isOpen, onClose, onExport }: Readonly<ExportDialogProps>) {
	const { dialogRef } = useDialogModal({ isOpen });

	if (!isOpen) return null;

	return (
		<dialog
			ref={dialogRef}
			aria-labelledby="export-dialog-title"
			className="fixed inset-0 z-50 flex items-center justify-center p-4 m-0 w-full h-full bg-transparent border-none backdrop:bg-black/20 backdrop:backdrop-blur-sm"
			onClose={onClose}
		>
			<button
				type="button"
				className="absolute inset-0 w-full h-full bg-transparent border-none cursor-default"
				onClick={onClose}
				aria-label="Close dialog"
				tabIndex={-1}
			/>
			<div className="relative w-full max-w-md p-6 bg-[#fbfcff] rounded-[18px] shadow-[0_16px_50px_rgba(105,117,170,0.14)] border border-miku-border animate-pop focus:outline-none">
				<h2
					id="export-dialog-title"
					className="mb-4 text-xl font-bold gradient-text flex items-center gap-2"
				>
					<NoteIcon className="text-miku-teal" size={18} />
					Export Crawled Data
					<NoteIcon className="hidden" size={18} />
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
						<span className="font-bold text-miku-text flex items-center gap-2">
							JSON Format <SparkleIcon className="hidden" size={12} />
						</span>
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
						<span className="font-bold text-miku-text flex items-center gap-2">
							CSV Format <HeartIcon className="hidden" size={12} />
						</span>
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
			</div>
		</dialog>
	);
}
