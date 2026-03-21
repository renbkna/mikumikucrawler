import { type RefObject, useEffect, useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";

interface UseDialogModalOptions {
	isOpen: boolean;
	onClose: () => void;
}

export function useDialogModal<T extends HTMLElement>({
	isOpen,
	onClose,
}: UseDialogModalOptions): {
	dialogRef: RefObject<HTMLDialogElement | null>;
	modalRef: RefObject<T | null>;
	initialFocusRef: RefObject<HTMLButtonElement | null>;
} {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const { modalRef, initialFocusRef } = useFocusTrap<T>({
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

	return { dialogRef, modalRef, initialFocusRef };
}
