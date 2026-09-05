import { useEffect, useState } from 'react';

/** Optional bridge: a newer web client must remain usable with an older desktop shell. */
export function useKeybindPortalStatus(): KeybindPortalStatus | null {
  const [status, setStatus] = useState<KeybindPortalStatus | null>(null);
  useEffect(() => {
    const api = window.backspace;
    if (!api?.getKeybindPortalStatus || !api.onKeybindPortalStatus) return;
    let current = true;
    let receivedEvent = false;
    const cleanup = api.onKeybindPortalStatus((next) => {
      receivedEvent = true;
      if (current) setStatus(next);
    });
    void api.getKeybindPortalStatus().then((next) => {
      if (current && !receivedEvent) setStatus(next);
    }).catch(() => {});
    return () => { current = false; cleanup(); };
  }, []);
  return status;
}
