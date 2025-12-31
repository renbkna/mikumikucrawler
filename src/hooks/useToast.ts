import { useCallback, useRef, useState } from "react";
import { TOAST_DEFAULTS } from "../constants";
import type { Toast } from "../types";

const MAX_TOASTS = 5;

interface UseToastReturn {
	toasts: Toast[];
	addToast: (type: Toast["type"], message: string, timeout?: number) => void;
	dismissToast: (id: number) => void;
}

export function useToast(): UseToastReturn {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const idCounterRef = useRef(0);

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

	const dismissToast = useCallback((id: number) => {
		setToasts((prevToasts) => prevToasts.filter((toast) => toast.id !== id));
	}, []);

	return { toasts, addToast, dismissToast };
}
