import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chatStore';
import { useJumpStore } from '../stores/jumpStore';
import { useUIStore } from '../stores/uiStore';

/**
 * Opens the conversation of a pending jump request (stores/jumpStore.ts).
 * Mounted once, in `AppLayout`, which owns the route: the address decides the
 * open space and channel, so this only writes it. On a phone the chat is also
 * a screen on the stack (`MobileSpacesScreen` and `MobileDmsScreen` push it
 * the same way). Nothing happens when the conversation is already open, and
 * the list takes the request from there.
 */
export function useJumpNavigation(): void {
  const navigate = useNavigate();
  const request = useJumpStore((state) => state.request);

  useEffect(() => {
    if (!request) return;
    const ui = useUIStore.getState();
    if (ui.isMobile) {
      const top = ui.mobileStack[ui.mobileStack.length - 1];
      if (top?.screen === 'channel-chat' && top.params?.channelId === request.channelId) return;
    } else if (useChatStore.getState().currentChannelId === request.channelId) {
      return;
    }
    navigate(`/channels/${request.spaceId}/${request.channelId}`);
    if (ui.isMobile) {
      ui.pushMobileScreen('channel-chat', { channelId: request.channelId, spaceId: request.spaceId });
    }
  }, [request, navigate]);
}
