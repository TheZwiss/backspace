import type { WebSocket } from 'ws';

export const VOICE_RECONNECT_GRACE_MS = 60_000;
export const MAX_PENDING_VOICE_RECONNECTS = 10_000;

export interface AuthenticatedSocket {
  ws: WebSocket;
  userId: string;
  username: string;
}

// ─── VoiceRoom Abstraction ─────────────────────────────────────────────────

export interface SpaceRoomMeta {
  type: 'space';
  spaceId: string;
}

export interface DmRoomMeta {
  type: 'dm';
  callerId: string;
  state: 'ringing' | 'active';
}

/** In-memory registry for federated calls on REMOTE instances. */
export interface FederatedCallEntry {
  dmChannelId: string | null;     // null for Path B (no local DM), late-bound when DM created mid-call
  federatedId: string;            // primary key — cross-instance stable
  callerId: string;               // local stub userId of the caller
  callerHomeUserId: string;
  federatedCallHost: string;      // peer origin of the host instance
  livekitUrl: string;
  tokens: Map<string, string>;    // homeUserId → LiveKit token
  ringedUserIds: string[];        // local userIds that received dm_call_incoming
  state: 'ringing' | 'active';
  startedAt: number;
}

export interface VoiceRoom {
  roomId: string;
  roomType: 'space' | 'dm';
  participants: Set<string>;
  metadata: SpaceRoomMeta | DmRoomMeta;
  startedAt: number;
}

/** Whole occupied seconds for the wire protocol; never exposes a server clock timestamp. */
export function getVoiceRoomElapsedSeconds(room: VoiceRoom, now = Date.now()): number {
  return Math.max(0, Math.floor((now - room.startedAt) / 1_000));
}

// ─── ConnectionManager ─────────────────────────────────────────────────────
