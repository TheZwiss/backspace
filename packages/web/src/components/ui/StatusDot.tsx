import React from 'react';

/** The small connection indicator next to an instance line: green when connected, amber while connecting, muted otherwise. */
export function StatusDot({ status }: { status: string }) {
  const colorClass =
    status === 'connected' ? 'bg-status-online' :
    status === 'connecting' ? 'bg-accent-amber' :
    'bg-txt-tertiary';

  return <div className={`w-2 h-2 rounded-full shrink-0 ${colorClass}`} />;
}
