import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { SoundboardLibrary } from './SoundboardLibrary';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getChannelOrigin, getMyUserIdForOrigin } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSoundboardStore, useSoundboardPreferences, soundboardKey } from '../../stores/soundboardStore';
import { stopSoundboardPlayback, updateSoundboardVolume } from '../../audio/soundboardPlayback';
import { shortcutFromEvent, sameShortcut, conflictsWithVoiceShortcut } from '../../utils/soundboardShortcuts';
import { getApiForOrigin } from '../../utils/crossStoreResolvers';
import { useUIStore } from '../../stores/uiStore';
import { describeError } from '../../i18n/errors';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';

export function SoundboardController() {
  const { t } = useTranslation('voice');
  const userId = useAuthStore(s => s.user?.id);
  const channelId = useVoiceStore(s => s.currentVoiceChannelId);
  const connected = useVoiceStore(s => s.isLiveKitConnected);
  const deafened = useVoiceStore(s => s.isDeafened);
  const spaceDeafened = useVoiceStore(s => s.spaceDeafenedUserIds);
  const outputVolume = useVoiceStore(s => s.outputVolume);
  const volume = useSoundboardPreferences(s => s.volume);
  const spaceId = useSpaceStore(s => channelId ? s.channelToSpaceMap.get(channelId) : undefined);
  const origins = useSpaceStore(s => s.channelOriginMap);
  const origin = channelId ? origins.get(channelId) ?? '' : '';
  const open = useSoundboardStore(s => s.open);
  const load = useSoundboardStore(s => s.load);
  const previousUser = useRef(userId);
  useEffect(() => {
    if (previousUser.current !== userId) { useSoundboardStore.getState().reset(); stopSoundboardPlayback(); }
    previousUser.current = userId;
  }, [userId]);
  useEffect(() => {
    if (userId && spaceId && connected) void load(origin, spaceId);
    useSoundboardStore.getState().setOpen(false);
    stopSoundboardPlayback();
    return stopSoundboardPlayback;
  }, [userId, channelId, spaceId, origin, connected, load]);
  useEffect(() => {
    const uid = getMyUserIdForOrigin(origin);
    if (deafened || spaceDeafened.has(`${spaceId}:${uid}`)) stopSoundboardPlayback();
  }, [deafened, spaceDeafened, spaceId, origin]);
  useEffect(updateSoundboardVolume, [volume, outputVolume]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || event.isComposing || !(event.target instanceof HTMLElement)
        || event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const voice = useVoiceStore.getState();
      const channel = voice.currentVoiceChannelId;
      const space = channel ? useSpaceStore.getState().channelToSpaceMap.get(channel) : undefined;
      if (!userId || !channel || !space || !voice.isLiveKitConnected || voice.isDeafened) return;
      const targetOrigin = getChannelOrigin(channel); const uid = getMyUserIdForOrigin(targetOrigin);
      if (voice.spaceMutedUserIds.has(`${space}:${uid}`) || voice.spaceDeafenedUserIds.has(`${space}:${uid}`)
        || !hasPermissionBit(useSpaceStore.getState().channelPermissions.get(channel), PermissionBits.SPEAK)) return;
      const shortcut = shortcutFromEvent(event);
      if (!shortcut || conflictsWithVoiceShortcut(shortcut)) return;
      const key = soundboardKey(targetOrigin, space);
      const document = useSoundboardStore.getState().entries[key]?.document;
      if (!document?.settings.enabled) return;
      const prefs = useSoundboardPreferences.getState();
      const sound = document.sounds.find(s => {
        const binding = prefs.shortcuts[`${key}:${s.id}`];
        return binding !== undefined && sameShortcut(binding, shortcut);
      });
      if (!sound || (document.settings.maxDurationSeconds !== null && sound.durationSeconds > document.settings.maxDurationSeconds)) return;
      event.preventDefault();
      void getApiForOrigin(targetOrigin).soundboard.play(space, sound.id, channel).catch(cause => useUIStore.getState().addToast(describeError(cause), 'warning'));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [userId]);
  return <Modal isOpen={open && !!spaceId && !!channelId && connected} onClose={() => useSoundboardStore.getState().setOpen(false)} maxWidth="max-w-2xl" mobileStyle="sheet">
    {spaceId && channelId && <SoundboardDialog key={`${origin}:${spaceId}:${channelId}`} title={t('soundboard.title')} origin={origin} spaceId={spaceId} channelId={channelId} />}
  </Modal>;
}

function SoundboardDialog({ title, origin, spaceId, channelId }: { title: string; origin: string; spaceId: string; channelId: string }) {
  const { t } = useTranslation('common');
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', trap, true);
    return () => { document.removeEventListener('keydown', trap, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="outline-none">
    <div className="flex justify-between items-center mb-4 gap-3">
      <h2 id={titleId} className="text-xl font-semibold text-txt-primary">{title}</h2>
      <button type="button" onClick={() => useSoundboardStore.getState().setOpen(false)} aria-label={t('actions.close')} className="w-10 h-10 rounded-full text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover">×</button>
    </div>
    <SoundboardLibrary origin={origin} spaceId={spaceId} channelId={channelId} />
  </div>;
}
