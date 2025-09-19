import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Toast } from '../types';

interface ToastNotificationProps {
  toast: Toast;
  onDismiss: (id: number) => void;
}

export function ToastNotification({
  toast,
  onDismiss,
}: ToastNotificationProps) {
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLeaving(true);
      setTimeout(() => {
        onDismiss(toast.id);
      }, 300); // Wait for exit animation
    }, toast.timeout - 300);

    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  const handleDismiss = () => {
    setIsLeaving(true);
    setTimeout(() => {
      onDismiss(toast.id);
    }, 300);
  };

  const toastStyles = {
    success: 'bg-green-50 border-green-200 text-green-800 border',
    error: 'bg-red-50 border-red-200 text-red-800 border',
    warning: 'bg-amber-50 border-amber-200 text-amber-800 border',
    info: 'bg-blue-50 border-blue-200 text-blue-800 border',
  };

  const buttonStyles = {
    success: 'text-green-600 hover:text-green-800',
    error: 'text-red-600 hover:text-red-800',
    warning: 'text-amber-600 hover:text-amber-800',
    info: 'text-blue-600 hover:text-blue-800',
  };

  return (
    <div
      className={`${
        toastStyles[toast.type]
      } px-4 py-3 rounded-lg shadow-lg backdrop-blur-sm flex items-center justify-between max-w-xs sm:max-w-md transition-all duration-300 hover:shadow-xl transform ${
        isLeaving
          ? 'translate-x-full opacity-0 scale-95'
          : 'translate-x-0 opacity-100 scale-100'
      } animate-in slide-in-from-right-full`}
    >
      <div className="mr-3 text-sm font-medium leading-relaxed">
        {toast.message}
      </div>
      <button
        onClick={handleDismiss}
        className={`${
          buttonStyles[toast.type]
        } transition-colors duration-200 flex-shrink-0 p-1 rounded-full hover:bg-white/50`}
        aria-label="Dismiss notification"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
