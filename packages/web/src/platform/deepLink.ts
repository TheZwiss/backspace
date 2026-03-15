import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isElectron } from './platform';

/**
 * Listens for deep link events from the Electron main process and navigates accordingly.
 *
 * Supported routes:
 *   backspace://join/{code}            → /join/{code}
 *   backspace://join/{code}@{host}     → /join/{code}@{host}
 *   backspace://channel/{spaceId}/{channelId} → /channels/{spaceId}/{channelId}
 */
export function useDeepLinkHandler(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isElectron()) return;

    const api = window.backspace!;
    api.onDeepLink((url: string) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        console.warn('[DeepLink] Invalid URL:', url);
        return;
      }

      if (parsed.protocol !== 'backspace:') return;

      // URL host + pathname gives us the route
      // backspace://join/code  → host="join", pathname="/code"
      // backspace://channel/spaceId/channelId → host="channel", pathname="/spaceId/channelId"
      const host = parsed.hostname;
      const pathParts = parsed.pathname.split('/').filter(Boolean);

      if (host === 'join' && pathParts.length >= 1) {
        const code = pathParts[0]!;
        navigate(`/join/${code}`);
      } else if (host === 'channel' && pathParts.length >= 2) {
        const spaceId = pathParts[0]!;
        const channelId = pathParts[1]!;
        navigate(`/channels/${spaceId}/${channelId}`);
      } else {
        console.warn('[DeepLink] Unknown route:', url);
      }
    });
  }, [navigate]);
}
