import React from 'react';
import { useUIStore } from '../../stores/uiStore';

interface MobileScreenHeaderProps {
  title: string;
  rightActions?: React.ReactNode;
}

export function MobileScreenHeader({ title, rightActions }: MobileScreenHeaderProps) {
  const popMobileScreen = useUIStore((s) => s.popMobileScreen);

  return (
    <header className="h-12 flex items-center gap-2 px-3 border-b border-border-soft bg-surface-base shrink-0">
      <button
        onClick={popMobileScreen}
        className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
      </button>
      <h1 className="text-sm font-semibold text-txt-primary flex-1 truncate">{title}</h1>
      {rightActions}
    </header>
  );
}
