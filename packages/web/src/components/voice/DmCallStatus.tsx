import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { canStartDmCall, joinDmCall } from '../../utils/voiceActions';

export function DmCallStatus({ channelId }: { channelId: string }) {
  const { t } = useTranslation('voice');
  const users = useVoiceStore((s) => s.voiceUsers.get(channelId));
  const deadline = useVoiceStore((s) => s.dmWaitingUntil.get(channelId));
  const active = useVoiceStore((s) => s.activeDmCall?.dmChannelId === channelId);
  const canJoin = useVoiceStore(canStartDmCall);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!deadline) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  if (!users?.length) return null;
  const seconds = Math.max(0, Math.ceil(((deadline ?? now) - now) / 1000));
  const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <div role="status" className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-accent-mint/10 border-b border-accent-mint/20 text-xs text-txt-primary">
    <span>{deadline ? t('callWaiting', { remaining }) : t('callOngoing')}</span>
    {!active && <button className="rounded-md px-3 py-1 bg-accent-mint/20 disabled:opacity-50" disabled={!canJoin} onClick={() => joinDmCall(channelId)}>{t('rejoinCall')}</button>}
  </div>;
}
