import React from 'react';
import { useUIStore } from '../../stores/uiStore';

const borderColors = {
  info: 'border-l-accent-sky',
  warning: 'border-l-accent-amber',
  success: 'border-l-accent-mint',
} as const;

export function ToastContainer() {
  const toasts = useUIStore((s) => s.toasts);
  const removeToast = useUIStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[300] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`glass-pill border-l-2 ${borderColors[toast.type]} rounded-[10px] px-4 py-2.5 max-w-[320px] animate-slide-up pointer-events-auto cursor-pointer`}
          onClick={() => removeToast(toast.id)}
        >
          <span className="text-sm text-txt-primary leading-snug">{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
