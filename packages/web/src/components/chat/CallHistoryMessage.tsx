import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormatters } from '../../i18n/formatters';
import type { CallHistoryEvent } from '@backspace/shared/src/dmSystemEvents';

const appearance = {
  active: { frame: 'border-emerald-400/25 bg-emerald-400/[0.04]', text: 'text-emerald-300', badge: 'bg-emerald-400/10', mark: 'M7 12h2l2-5 2 10 2-5h2' },
  ended: { frame: 'border-sky-400/20 bg-sky-400/[0.04]', text: 'text-sky-300', badge: 'bg-sky-400/10', mark: 'm7 12 3 3 7-7' },
  ringing: { frame: 'border-amber-400/25 bg-amber-400/[0.04]', text: 'text-amber-300', badge: 'bg-amber-400/10', mark: 'M12 8v4l3 2' },
  cancelled: { frame: 'border-slate-400/20 bg-slate-400/[0.04]', text: 'text-slate-300', badge: 'bg-slate-400/10', mark: 'm8 8 8 8m0-8-8 8' },
  missed: { frame: 'border-rose-400/25 bg-rose-400/[0.04]', text: 'text-rose-300', badge: 'bg-rose-400/10', mark: 'M16 8 8 16m0-7v7h7' },
  rejected: { frame: 'border-rose-400/25 bg-rose-400/[0.04]', text: 'text-rose-300', badge: 'bg-rose-400/10', mark: 'm7 17 10-10' },
  interrupted: { frame: 'border-orange-400/25 bg-orange-400/[0.04]', text: 'text-orange-300', badge: 'bg-orange-400/10', mark: 'M12 7v6m0 3v1' },
} satisfies Record<CallHistoryEvent['status'], { frame: string; text: string; badge: string; mark: string }>;

export function CallHistoryMessage({ event, actorName }: { event: CallHistoryEvent; actorName: string }) {
  const { t } = useTranslation('voice');
  const f = useFormatters();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (event.status !== 'active') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [event.status, event.connectedAt]);
  const seconds = event.connectedAt === null || event.status === 'interrupted' ? null : Math.max(0, Math.floor(((event.endedAt ?? now) - event.connectedAt) / 1000));
  const duration = seconds === null ? '—' : seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const look = appearance[event.status];
  const date = f.formatMediumDate;
  const clock = (value: number) => f.formatTime(value, true);
  const timestamp = (label: string, value: number) => <div className="min-w-0">
    <div className="text-[10px] uppercase tracking-wider text-txt-tertiary mb-1">{label}</div>
    <time dateTime={new Date(value).toISOString()} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-xs font-medium tabular-nums text-txt-secondary">{clock(value)}</span>
      <span className="text-[10px] text-txt-tertiary">{date(value)}</span>
    </time>
  </div>;
  return <div className="px-4 py-2">
    <div className={`max-w-lg overflow-hidden rounded-2xl border ${look.frame}`}>
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <div aria-hidden="true" className={`shrink-0 flex h-10 w-10 items-center justify-center rounded-xl ${look.badge} ${look.text}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" opacity="0.4" />
            <path d={look.mark} />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${look.badge} ${look.text}`}>
            <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${event.status === 'active' ? 'motion-safe:animate-pulse' : ''}`} />
            {t(`history.status.${event.status}`)}
          </div>
          <div className="mt-1.5 text-xs leading-relaxed text-txt-secondary break-words">{t('history.startedBy', { actor: actorName })}</div>
        </div>
        {seconds !== null && <div className="shrink-0 text-right">
          <div className={`text-xl font-semibold leading-none tracking-tight tabular-nums ${look.text}`}>{duration}</div>
          <div className="mt-1 text-[10px] text-txt-tertiary">{t('history.duration')}</div>
        </div>}
      </div>
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-x-4 gap-y-3 border-t border-white/5 bg-black/10 px-4 py-3">
        {timestamp(t('history.from'), event.connectedAt ?? event.startedAt)}
        {event.endedAt !== null && timestamp(t('history.to'), event.endedAt)}
      </div>
    </div>
  </div>;
}
