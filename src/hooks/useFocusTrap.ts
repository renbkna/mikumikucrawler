import { type RefObject, useEffect, useRef } from "react";

interface UseFocusTrapOptions {
	isOpen: boolean;
	onClose: () => void;
}

/**
 * Custom hook to manage focus trapping within modals/dialogs.
 * Handles Escape key to close, Tab key cycling, and initial focus.
 */
export function useFocusTrap<T extends HTMLElement>(
	options: UseFocusTrapOptions,
): {
	modalRef: RefObject<T | null>;
	initialFocusRef: RefObject<HTMLElement | null>;
} {
	const { isOpen, onClose } = options;
	const modalRef = useRef<T | null>(null);
	const initialFocusRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!isOpen) return;

		// Focus initial element when modal opens
		const focusTimer = setTimeout(() => {
			initialFocusRef.current?.focus();
		}, 0);

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
				return;
			}

			// Focus trap
			if (e.key === "Tab" && modalRef.current) {
				const focusableElements =
					modalRef.current.querySelectorAll<HTMLElement>(
						'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
					);

				if (focusableElements.length === 0) return;

				const firstElement = focusableElements[0];
				const lastElement = focusableElements[focusableElements.length - 1];

				if (e.shiftKey && document.activeElement === firstElement) {
					e.preventDefault();
					lastElement?.focus();
				} else if (!e.shiftKey && document.activeElement === lastElement) {
					e.preventDefault();
					firstElement?.focus();
				}
			}
		};

		document.addEventListener("keydown", handleKeyDown);

		return () => {
			clearTimeout(focusTimer);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [isOpen, onClose]);

	return { modalRef, initialFocusRef };
}
