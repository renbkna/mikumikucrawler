import { type ReactNode, useLayoutEffect, useRef } from "react";

const PANEL_SIZE_CLASSES = {
	md: "max-w-md",
	xl: "max-w-xl max-h-[90vh] overflow-y-auto",
} as const;

interface ModalProps {
	labelledBy: string;
	size: keyof typeof PANEL_SIZE_CLASSES;
	onClose: () => void;
	children: ReactNode;
}

/** A modal dialog that is open for as long as it is mounted. */
export function Modal({ labelledBy, size, onClose, children }: Readonly<ModalProps>) {
	const dialogRef = useRef<HTMLDialogElement>(null);

	useLayoutEffect(() => {
		const dialog = dialogRef.current;
		if (dialog && !dialog.open) dialog.showModal();
	}, []);

	return (
		<dialog
			ref={dialogRef}
			aria-labelledby={labelledBy}
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
				className={`relative w-full ${PANEL_SIZE_CLASSES[size]} p-6 bg-[#fbfcff] rounded-[18px] shadow-[0_16px_50px_rgba(105,117,170,0.14)] border border-miku-border animate-pop focus:outline-none`}
			>
				{children}
			</div>
		</dialog>
	);
}
