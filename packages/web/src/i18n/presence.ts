/**
 * The label for a presence state, in the selected language.
 *
 * Presence is a closed union on the wire (`online`, `idle`, `dnd`, anything
 * else meaning offline), so every member is listed here once and every
 * surface that shows it (friends list, profile, member sidebar, status
 * picker) reads the same four `common:states.*` keys.
 */
export type PresenceKey =
  | 'common:states.online'
  | 'common:states.idle'
  | 'common:states.doNotDisturb'
  | 'common:states.offline';

export function presenceKey(status: string | null | undefined): PresenceKey {
  switch (status) {
    case 'online': return 'common:states.online';
    case 'idle': return 'common:states.idle';
    case 'dnd': return 'common:states.doNotDisturb';
    default: return 'common:states.offline';
  }
}

export function presenceLabel(t: (key: PresenceKey) => string, status: string | null | undefined): string {
  return t(presenceKey(status));
}
