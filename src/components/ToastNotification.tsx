import { X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { TOAST_DEFAULTS } from "../constants";
import type { Toast } from "../types";

// Moved outside component to prevent recreation on every render
const TOAST_STYLES = {
	success: "bg-emerald-50 border-2 border-emerald-200 text-emerald-700",
	error: "bg-rose-50 border-2 border-rose-200 text-rose-700",
	warning: "bg-amber-50 border-2 border-amber-200 text-amber-700",
	info: "bg-miku-teal/10 border-2 border-miku-teal/30 text-miku-teal",
} as const;

const BUTTON_STYLES = {
	success: "text-emerald-500 hover:text-emerald-700 hover:bg-emerald-100",
	error: "text-rose-500 hover:text-rose-700 hover:bg-rose-100",
	warning: "text-amber-500 hover:text-amber-700 hover:bg-amber-100",
	info: "text-miku-teal hover:text-miku-accent hover:bg-miku-teal/10",
} as const;

const EMOJIS = {
	success: "✧",
	error: "!",
	warning: "♪",
	info: "♥",
} as const;

interface ToastNotificationProps {
	toast: Toast;
	onDismiss: (id: number) => void;
}

export const ToastNotification = memo(function ToastNotification({
	toast,
	onDismiss,
}: ToastNotificationProps) {
	const [isLeaving, setIsLeaving] = useState(false);
	const isDismissedRef = useRef(false);
	const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const timer = setTimeout(
			() => {
				if (isDismissedRef.current) return;
				isDismissedRef.current = true;
				setIsLeaving(true);
				dismissTimerRef.current = setTimeout(() => {
					onDismiss(toast.id);
				}, TOAST_DEFAULTS.EXIT_ANIMATION_MS);
			},
			Math.max(toast.timeout - TOAST_DEFAULTS.EXIT_ANIMATION_MS, 0),
		);

		return () => {
			clearTimeout(timer);
			if (dismissTimerRef.current) {
				clearTimeout(dismissTimerRef.current);
			}
		};
	}, [toast, onDismiss]);

	const handleDismiss = () => {
		if (isDismissedRef.current) return;
		isDismissedRef.current = true;
		setIsLeaving(true);
		dismissTimerRef.current = setTimeout(() => {
			onDismiss(toast.id);
		}, TOAST_DEFAULTS.EXIT_ANIMATION_MS);
	};

	return (
		<div
			className={`${
				TOAST_STYLES[toast.type]
			} px-4 py-3 rounded-2xl shadow-lg backdrop-blur-sm flex items-center justify-between max-w-xs sm:max-w-md transition-all duration-300 transform ${
				isLeaving
					? "translate-x-full opacity-0 scale-95"
					: "translate-x-0 opacity-100 scale-100"
			} animate-in slide-in-from-right-full`}
		>
			<div className="mr-3 text-sm font-bold leading-relaxed flex items-center gap-2">
				<span>{EMOJIS[toast.type]}</span>
				{toast.message}
			</div>
			<button
				type="button"
				onClick={handleDismiss}
				className={`${
					BUTTON_STYLES[toast.type]
				} transition-colors duration-200 flex-shrink-0 p-1 rounded-full`}
				aria-label="Dismiss notification"
			>
				<X className="w-4 h-4" />
			</button>
		</div>
	);
});

ToastNotification.displayName = "ToastNotification";
