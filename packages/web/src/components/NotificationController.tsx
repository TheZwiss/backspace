import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore, addedRealtimeMessageEvents } from '../stores/chatStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { isElectron } from '../platform/platform';
import { onNotificationClick, updateBadgeCount } from '../platform/notifications';
import { showAlertNotification } from '../utils/alerts';
import i18n from '../i18n';
import { useSpaceStore, getMyUserIdForOrigin } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { replaceEmojiShortcodesInMarkdownSource } from '../utils/emojiShortcodes';

/**
 * Headless component that bridges store events to native OS notifications and badge counts.
 * Renders nothing — lives alongside SoundController in AppLayout.
 *
 * Notifications go through `showAlertNotification`, which applies the Do Not
 * Disturb rule; the badge does not, because it is silent (sounds.md).
 */
export function NotificationController() {
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const isInitialMount = useRef(true);
  const windowFocused = useRef(true);

  useEffect(() => onNotificationClick(({ channelId, spaceId, userId }) => {
    if (!channelId || !userId || userId !== useAuthStore.getState().user?.id) return;
    const spaces = useSpaceStore.getState();
    const targetSpace = spaces.channelToSpaceMap.get(channelId);
    if (targetSpace !== spaceId || (!targetSpace && !spaces.dmChannels.some(dm => dm.id === channelId))) return;
    const resolvedSpace = targetSpace || '@me';
    const ui = useUIStore.getState();
    if (ui.isMobile) {
      const top = ui.mobileStack.at(-1);
      if (top?.screen !== 'channel-chat' || top.params?.channelId !== channelId) {
        ui.pushMobileScreen('channel-chat', { channelId, spaceId: resolvedSpace });
      }
    }
    navigate(`/channels/${targetSpace ? encodeURIComponent(targetSpace) : '@me'}/${encodeURIComponent(channelId)}`);
  }), [navigate]);

  // Track window focus state
  useEffect(() => {
    if (isElectron() && window.backspace) {
      window.backspace.onWindowFocusChange((focused) => {
        windowFocused.current = focused;
      });
    }

    // Browser fallback focus tracking
    const onFocus = () => { windowFocused.current = true; };
    const onBlur = () => { windowFocused.current = false; };
    const onVisibility = () => {
      windowFocused.current = document.visibilityState === 'visible' && document.hasFocus();
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);

    // Sync initial state
    windowFocused.current = document.hasFocus();

    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Message notifications
  useEffect(() => {
    const timer = setTimeout(() => {
      isInitialMount.current = false;
    }, 1000);

    const unsubscribeChat = useChatStore.subscribe((state, prevState) => {
      if (isInitialMount.current) return;
      if (windowFocused.current) return;

      if (state.realtimeMessageEvents !== prevState.realtimeMessageEvents) {
        const newEvents = addedRealtimeMessageEvents(prevState.realtimeMessageEvents, state.realtimeMessageEvents);
        for (const { message } of newEvents) {
          const { channelToSpaceMap, channelOriginMap } = useSpaceStore.getState();
          if (message.userId !== getMyUserIdForOrigin(channelOriginMap.get(message.channelId) ?? '')) {
            // i18n.t, not a hook: read at notification time, in the language
            // selected now rather than when this subscription was made.
            const displayName = message.user?.displayName || message.user?.username || i18n.t('chat:notification.unknownSender');
            const body = message.content
              ? replaceEmojiShortcodesInMarkdownSource(message.content).replace(/[*_~`>#\-\[\]]/g, '').slice(0, 100)
              : i18n.t('chat:notification.attachmentOnly');
            showAlertNotification('message', displayName, body, {
              channelId: message.channelId,
              spaceId: channelToSpaceMap.get(message.channelId),
              userId: currentUser?.id,
            });
            break; // one notification per batch
          }
        }
      }
    });

    return () => {
      clearTimeout(timer);
      unsubscribeChat();
    };
  }, [currentUser?.id]);

  // Badge count (Electron only)
  useEffect(() => {
    const unsubscribe = useChatStore.subscribe((state) => {
      updateBadgeCount(state.unreadChannels.size);
    });
    return unsubscribe;
  }, []);

  // DM call notification
  useEffect(() => {
    let prevIncoming: { dmChannelId: string | null; callerId: string; callerName: string } | null = null;

    const unsubscribe = useVoiceStore.subscribe((state) => {
      if (state.incomingCall && !prevIncoming && !windowFocused.current) {
        showAlertNotification(
          'incoming_call',
          i18n.t('voice:incomingCall.notificationTitle'),
          i18n.t('voice:incomingCall.notificationBody', { name: state.incomingCall.callerName }),
          {
            channelId: state.incomingCall.dmChannelId ?? undefined,
            userId: useAuthStore.getState().user?.id,
          },
        );
      }
      prevIncoming = state.incomingCall;
    });
    return unsubscribe;
  }, []);

  return null;
}
