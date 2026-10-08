import { useVoiceStore } from '../stores/voiceStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useDmViewer } from './useDmViewer';
import { dmCallChannelId } from '../utils/dmCall';
import { formatDmHeaderName } from '../utils/dmFormatters';

/**
 * The conversation of the DM call the client is in, as this client can open
 * it (`dmCallChannelId`): the id to navigate to, and its title as the DM
 * header shows it. Both null outside a DM call, and the id is null when the
 * client has no copy of the conversation (a call rung by an instance that has
 * none, with no other connection that has one).
 */
export function useActiveDmCall(): { dmChannelId: string | null; title: string | null } {
  const activeDmCall = useVoiceStore((s) => s.activeDmCall);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const dmChannelId = activeDmCall ? dmCallChannelId(activeDmCall, dmChannels) : null;
  const dm = dmChannelId ? dmChannels.find((d) => d.id === dmChannelId) : undefined;
  const viewer = useDmViewer(dm?.id ?? null);
  return { dmChannelId, title: dm ? formatDmHeaderName(dm, viewer) : null };
}
