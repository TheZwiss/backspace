import { useMemo } from 'react';
import { useSelfIdentity } from '../stores/authStore';
import { useSpaceStore } from '../stores/spaceStore';
import type { DmViewer } from '../utils/dmFormatters';

/**
 * Who is looking at the DM `dmId` (`DmViewer`): the signed-in user and the
 * instance that issued the DM's member rows. Re-renders when either changes.
 */
export function useDmViewer(dmId: string | null | undefined): DmViewer {
  const self = useSelfIdentity();
  const origin = useSpaceStore((s) => (dmId ? s.channelOriginMap.get(dmId) ?? '' : ''));
  return useMemo(() => ({ self, origin }), [self, origin]);
}
