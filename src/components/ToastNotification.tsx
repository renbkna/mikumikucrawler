import { useEffect } from "react";
import { X } from "lucide-react";
import { Toast } from "../types";

interface ToastNotificationProps {
  toast: Toast;
  onDismiss: (id: number) => void;
}

export function ToastNotification({ toast, onDismiss }: ToastNotificationProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, toast.timeout);

    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  const bgColors = {
    success: 'bg-green-500',
    error: 'bg-red-500',
    warning: 'bg-yellow-500',
    info: 'bg-blue-500'
  };

  return (
    <div className={`${bgColors[toast.type]} text-white px-4 py-3 rounded-lg shadow-lg flex items-center justify-between max-w-xs sm:max-w-md`}>
      <div className="mr-2">{toast.message}</div>
      <button onClick={() => onDismiss(toast.id)} className="text-white hover:text-gray-200">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
