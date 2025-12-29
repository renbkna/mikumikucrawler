import { useCallback, useRef, useState } from "react";
import { TOAST_DEFAULTS } from "../constants";
import type { Toast } from "../types";

const MAX_TOASTS = 5;

interface UseToastReturn {
	toasts: Toast[];
	addToast: (type: Toast["type"], message: string, timeout?: number) => void;
	dismissToast: (id: number) => void;
}

/** Provides a simple management interface for ephemeral toast notifications. */
export function useToast(): UseToastReturn {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const idCounterRef = useRef(0);

	/**
	 * Adds a new toast notification to the queue.
	 *
	 * @param type - Severity of the toast (success, error, etc)
	 * @param message - Text content to display
	 * @param timeout - Duration in milliseconds before auto-dismissal
	 */
	const addToast = useCallback(
		(
			type: Toast["type"],
			message: string,
			timeout: number = TOAST_DEFAULTS.DEFAULT_TIMEOUT,
		) => {
			idCounterRef.current += 1;
			const id = idCounterRef.current;
			setToasts((prevToasts) => {
				const newToasts = [...prevToasts, { id, type, message, timeout }];
				return newToasts.length > MAX_TOASTS
					? newToasts.slice(-MAX_TOASTS)
					: newToasts;
			});
		},
		[],
	);

	/**
	 * Manually removes a toast by its unique ID.
	 */
	const dismissToast = useCallback((id: number) => {
		setToasts((prevToasts) => prevToasts.filter((toast) => toast.id !== id));
	}, []);

	return { toasts, addToast, dismissToast };
}
