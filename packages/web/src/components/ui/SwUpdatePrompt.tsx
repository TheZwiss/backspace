import { useRegisterSW } from 'virtual:pwa-register/react';

export function SwUpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] glass-pill px-4 py-2.5 flex items-center gap-3 text-sm text-txt-primary shadow-lg">
      <span>A new version is available</span>
      <button
        onClick={() => updateServiceWorker(true)}
        className="px-3 py-1 rounded-md bg-accent-primary text-white text-xs font-medium hover:opacity-90 transition-opacity"
      >
        Reload
      </button>
    </div>
  );
}
