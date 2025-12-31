import { Download } from "lucide-react";
import { useEffect, useRef } from "react";
import { useFocusTrap } from "../hooks";
import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface ExportDialogProps {
	isOpen: boolean;
	onClose: () => void;
	onExport: (format: string) => void;
}

export function ExportDialog({
	isOpen,
	onClose,
	onExport,
}: Readonly<ExportDialogProps>) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const { modalRef, initialFocusRef } = useFocusTrap<HTMLDivElement>({
		isOpen,
		onClose,
	});

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		if (isOpen && !dialog.open) {
			dialog.showModal();
		} else if (!isOpen && dialog.open) {
			dialog.close();
		}
	}, [isOpen]);

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
			<div
				ref={modalRef}
				className="relative w-full max-w-md p-6 bg-white rounded-3xl shadow-xl border-2 border-miku-pink/20 animate-pop focus:outline-none"
			>
				<h2
					id="export-dialog-title"
					className="mb-4 text-xl font-black gradient-text flex items-center gap-2"
				>
					<NoteIcon className="text-miku-teal" size={18} />
					Export Crawled Data
					<NoteIcon className="text-miku-pink" size={18} />
				</h2>

				<div className="space-y-3">
					<button
						type="button"
						ref={initialFocusRef as React.RefObject<HTMLButtonElement>}
						onClick={() => {
							onExport("json");
							onClose();
						}}
						className="flex items-center justify-between w-full p-4 border-2 border-miku-teal/20 rounded-2xl bg-miku-teal/5 hover:bg-miku-teal/10 hover:border-miku-teal/40 focus:ring-2 focus:ring-miku-teal focus:outline-none transition-all group"
					>
						<span className="font-bold text-miku-text flex items-center gap-2">
							JSON Format <SparkleIcon className="text-miku-teal" size={12} />
						</span>
						<Download className="w-5 h-5 text-miku-teal group-hover:scale-110 transition-transform" />
					</button>

					<button
						type="button"
						onClick={() => {
							onExport("csv");
							onClose();
						}}
						className="flex items-center justify-between w-full p-4 border-2 border-miku-pink/20 rounded-2xl bg-miku-pink/5 hover:bg-miku-pink/10 hover:border-miku-pink/40 focus:ring-2 focus:ring-miku-pink focus:outline-none transition-all group"
					>
						<span className="font-bold text-miku-text flex items-center gap-2">
							CSV Format <HeartIcon className="text-miku-pink" size={12} />
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
