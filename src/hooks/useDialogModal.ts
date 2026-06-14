import { type RefObject, useLayoutEffect, useRef } from "react";

interface UseDialogModalOptions {
	isOpen: boolean;
}

export function useDialogModal({ isOpen }: UseDialogModalOptions): {
	dialogRef: RefObject<HTMLDialogElement | null>;
} {
	const dialogRef = useRef<HTMLDialogElement>(null);

	useLayoutEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		if (isOpen && !dialog.open) {
			dialog.showModal();
		} else if (!isOpen && dialog.open) {
			dialog.close();
		}
	}, [isOpen]);

	return { dialogRef };
}
