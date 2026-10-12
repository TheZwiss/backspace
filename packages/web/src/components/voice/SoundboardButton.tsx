import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSoundboardStore } from '../../stores/soundboardStore';

export function SoundboardButton({ className = 'w-10 h-10 rounded-full bg-surface-channel text-txt-secondary hover:text-txt-primary flex items-center justify-center' }: { className?: string }) {
  const { t } = useTranslation('voice');
  const channelId = useVoiceStore(s => s.currentVoiceChannelId);
  const connected = useVoiceStore(s => s.isLiveKitConnected);
  const open = useSoundboardStore(s => s.open);
  if (!channelId) return null;
  return <button type="button" disabled={!connected} onClick={() => useSoundboardStore.getState().setOpen(true)}
    className={`${className} disabled:opacity-40`} title={t('soundboard.title')} aria-label={t('soundboard.title')} aria-haspopup="dialog" aria-expanded={open}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M7 10v4m5-7v10m5-7v4"/></svg>
  </button>;
}
