import { useVoiceStore } from '../stores/voiceStore';

/**
 * Snapshot of a single space's voice presence, delivered by the server's
 * `space_voice_state` WebSocket event when the user joins a space mid-session.
 * Mirrors the per-space slice of the `ready` payload (see server
 * `ConnectionManager.buildSpaceVoiceState`).
 */
export interface SpaceVoiceStateSnapshot {
  spaceId: string;
  voiceStates: Record<string, string[]>;
  voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>;
  spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }>;
}

/**
 * Apply a `space_voice_state` snapshot to the voice store.
 *
 * Scoped strictly to `snapshot.spaceId`: voice-channel occupants and per-user
 * statuses are merged in (channel IDs are globally unique, so this never
 * collides with other spaces), and the space-level restriction sets
 * (`spaceMuted`/`spaceDeafened`/`permissionMuted`) are rebuilt for THIS space
 * only — keys for other spaces are left untouched. This makes the apply
 * idempotent and authoritative for the joined space without disturbing live
 * voice state elsewhere (e.g. a channel the user is actively sitting in).
 *
 * The `ready` handler bootstraps the same data per-origin at connect time; this
 * is the mid-session join counterpart and deliberately does NOT clear by origin.
 */
export function applySpaceVoiceState(snapshot: SpaceVoiceStateSnapshot): void {
  const { setVoiceUsers, setVoiceUserStatus } = useVoiceStore.getState();

  for (const [channelId, userIds] of Object.entries(snapshot.voiceStates)) {
    setVoiceUsers(channelId, userIds);
  }
  for (const [userId, status] of Object.entries(snapshot.voiceUserStates)) {
    setVoiceUserStatus(userId, status.isMuted, status.isDeafened, status.isCameraOn, status.isScreenSharing);
  }

  const vs = useVoiceStore.getState();
  const nextSpaceMuted = new Set(vs.spaceMutedUserIds);
  const nextSpaceDeafened = new Set(vs.spaceDeafenedUserIds);
  const nextPermissionMuted = new Set(vs.permissionMutedUserIds);

  // Restriction Sets are keyed `spaceId:userId`. Drop this space's existing keys
  // so a re-sync is authoritative, then re-add from the snapshot.
  const prefix = `${snapshot.spaceId}:`;
  for (const key of [...nextSpaceMuted]) if (key.startsWith(prefix)) nextSpaceMuted.delete(key);
  for (const key of [...nextSpaceDeafened]) if (key.startsWith(prefix)) nextSpaceDeafened.delete(key);
  for (const key of [...nextPermissionMuted]) if (key.startsWith(prefix)) nextPermissionMuted.delete(key);

  for (const [key, state] of Object.entries(snapshot.spaceVoiceStates)) {
    if (state.spaceMuted) nextSpaceMuted.add(key);
    if (state.spaceDeafened) nextSpaceDeafened.add(key);
    if (state.permissionMuted) nextPermissionMuted.add(key);
  }

  useVoiceStore.setState({
    spaceMutedUserIds: nextSpaceMuted,
    spaceDeafenedUserIds: nextSpaceDeafened,
    permissionMutedUserIds: nextPermissionMuted,
  });
}
