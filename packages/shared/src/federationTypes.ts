import type { Activity, AvatarColor, User } from './types.js';

// ─── Federation Relay Types ──────────────────────────────────────────────────

export interface FederationRelayParticipant {
  homeUserId: string;
  homeInstance: string;
  profile?: FederationRelayProfileSnapshot;
}

export interface FederationRelayEvent {
  eventType: 'create' | 'update' | 'delete' | 'reaction_add' | 'reaction_remove'
    | 'member_add' | 'member_remove' | 'ownership_transfer' | 'group_metadata_update'
    | 'friend_request_create' | 'friend_request_update' | 'friend_request_cancel'
    | 'friend_add' | 'friend_remove' | 'file_rejected'
    | 'dm_call_start' | 'dm_call_accept' | 'dm_call_reject' | 'dm_call_end'
    | 'dm_typing_start' | 'dm_typing_stop'
    | 'profile_update' | 'presence_update'
    | 'read_state_update'
    | 'dm_close' | 'dm_reopen';
  contextType?: 'dm' | 'friend' | 'profile';
  dmChannelId?: string;
  messageId: string;
  federatedId?: string;
  encryptionVersion: 0;
  timestamp: number;
  participants?: FederationRelayParticipant[];
  message?: {
    userId: string;
    homeUserId: string;
    homeInstance: string;
    type?: 'user' | 'system';
    content: string | null;
    /** The sender's local id of the replied-to message. Meaningless to a receiver, which never adopts it; see `replyTo`. */
    replyToId: string | null;
    /**
     * The replied-to message in coordinates every instance shares. Optional:
     * absent from older senders and on messages that are not replies. The
     * receiver resolves it inside the conversation the message lands in and
     * stores no reply target when it does not resolve there.
     */
    replyTo?: FederationMessageRef | null;
    /**
     * The users the content's `<@id>` tokens name, each as the sender's id
     * with the federated identity it stands for. Optional: absent from older
     * senders, from system messages and from content that mentions nobody.
     * The receiver rewrites each token to its own row for that identity; see
     * `FederationMentionRef`.
     */
    mentions?: FederationMentionRef[];
    editedAt: number | null;
    createdAt: number;
    attachments?: FederationRelayAttachment[];
  };
  reactions?: FederationRelayReaction[];
  reaction?: FederationRelayReaction;
  /**
   * `update` / `delete`: the message being changed and who is changing it.
   * Optional: older senders omit it and are matched by `messageId` alone. See
   * `FederationMessageTarget` for how a receiver applies it.
   */
  target?: FederationMessageTarget;
  membership?: FederationMembershipPayload;
  ownership?: FederationOwnershipPayload;
  group?: FederationGroupPayload;
  friendship?: FederationFriendshipPayload;
  // file_rejected event fields
  attachmentId?: string;
  sourceFilename?: string;
  rejectionReason?: string;
  rejectionLimit?: number;
  affectedUserIds?: string[];
  call?: FederationCallPayload;
  typing?: {
    homeUserId: string;
    homeInstance: string;
    username: string;
  };
  metadata?: FederationGroupMetadataPayload;
  profileUpdate?: FederationProfileUpdatePayload;
  presenceUpdate?: FederationPresenceUpdatePayload;
  readState?: {
    user: { homeUserId: string; homeInstance: string };
    messageRef: { sourceInstance: string; sourceMessageId: string };
  };
  dmCloseReopen?: {
    homeUserId: string;
    homeInstance: string;
  };
}

export interface FederationCallPayload {
  livekitUrl?: string;
  tokens?: Record<string, string>;  // homeUserId → LiveKit token
  caller?: { homeUserId: string; homeInstance: string; displayName: string };
  acceptor?: { homeUserId: string; homeInstance: string };
  rejector?: { homeUserId: string; homeInstance: string };
  endedBy?: { homeUserId: string; homeInstance: string };
  participants?: FederationRelayParticipant[];  // All DM members for Path B identity matching
}

export interface FederationMembershipPayload {
  user: FederationRelayParticipant;
  addedBy?: FederationRelayParticipant;
  removedBy?: FederationRelayParticipant;
  reason?: 'kick' | 'leave';
}

export interface FederationOwnershipPayload {
  newOwner: FederationRelayParticipant;
  previousOwner: FederationRelayParticipant;
}

export interface FederationGroupPayload {
  owner: FederationRelayParticipant;
  members: FederationRelayParticipant[];
  // Group metadata snapshot — used by bootstrap path on a fresh peer.
  // Mirrors current owner-instance values at the moment of the member_add event.
  name: string | null;
  icon: string | null;            // absolute URL
  metadataUpdatedAt: number;
}

export interface FederationGroupMetadataPayload {
  name: string | null;     // explicit null = cleared
  icon: string | null;     // absolute URL on the wire; null = cleared
  metadataUpdatedAt: number;
  actor: FederationRelayParticipant; // == owner by authority invariant; used for system-message rendering
}

export interface FederationRelayProfileSnapshot {
  username?: string | null;
  displayName?: string | null;
  avatar?: string | null;
  avatarColor?: string | null;
  banner?: string | null;
  bio?: string | null;
  // Current presence at the moment the snapshot was built. Optional for
  // backwards compatibility with peers that pre-date the field. Receivers use
  // this to seed the stub's status at creation time, so a freshly-friended
  // remote user shows their actual current state instead of defaulting to
  // 'offline' until the next presence_update arrives. presence_update is
  // ephemeral and fires only on transitions, so without this field an
  // already-online remote stays stuck at 'offline' on the receiver until they
  // next change status.
  status?: 'online' | 'idle' | 'dnd' | 'offline' | null;
  /**
   * The user is tombstoned on the instance that built this snapshot.
   * Receivers must not create a new stub for this identity; internal
   * '!deleted:<id>' usernames are never shipped (dead-incarnation spec §3.3).
   */
  deleted?: boolean | null;
}

export interface FederationProfileUpdatePayload {
  homeUserId: string;
  homeInstance: string;
  profileUpdatedAt: number;
  // Home user's canonical username (without @domain suffix). Receivers apply
  // `displayName ?? username` so stubs whose home user has no displayName show
  // the real handle instead of getting clobbered to null. Username itself is
  // immutable on the home instance — receivers do NOT rewrite the stub's
  // username column on profile_update.
  username: string;
  displayName: string | null;
  avatar: string | null;
  banner: string | null;
  accentColor: string | null;
  avatarColor: string | null;
  bio: string | null;
}

/**
 * Presence projection from a home instance to peers. Carries the user's current
 * online status and (optionally) rich activities. Outbox-only on the wire — never
 * written to federation_mutation_log; presence is ephemeral and stale replays on
 * peer activation are wrong (the activation hook re-emits a fresh snapshot).
 */
export interface FederationPresenceUpdatePayload {
  homeUserId: string;
  homeInstance: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  activities?: Activity[];
  ts: number; // emitter clock; receiver may use for last-write-wins
}

export interface FederationFriendshipPayload {
  from: FederationRelayParticipant;
  to: FederationRelayParticipant;
  fromProfile?: FederationRelayProfileSnapshot;
  toProfile?: FederationRelayProfileSnapshot;
  status?: 'pending' | 'accepted' | 'declined';
  createdAt: number;
}

/**
 * A DM message named across instances. Every instance holds its own copy of a
 * federated message under its own local id, so a reference that crosses
 * instances uses the id the message has on the instance it was created on,
 * together with that instance's origin (as its `getOurOrigin()` reports it).
 */
export interface FederationMessageRef {
  messageId: string;
  messageHomeInstance: string;
}

/**
 * One user a relayed message's content mentions.
 *
 * A `<@id>` token carries an id issued by the instance the content was written
 * on, which names nobody on another instance. `id` is that id as it appears in
 * the relayed content; `homeUserId` + `homeInstance` is the federated identity
 * of the user it names there. A receiver resolves the identity to its own row
 * and rewrites `<@id>` to that row's id before storing the content, and keeps
 * the token as written when it holds no row for the identity.
 */
export interface FederationMentionRef {
  id: string;
  homeUserId: string;
  homeInstance: string;
}

/**
 * The message an `update` or `delete` relay changes.
 *
 * `messageId` on the event is the sender's local id, which only identifies the
 * message when the sender created it. A receiver given a target instead
 * resolves `message` inside its copy of the conversation `federatedId`, and
 * applies the change only when `actor` is that message's author, compared as
 * federated identities, and `actor` passes the relay attribution check. The
 * rule is written out in docs/systems/dm-system.md, "Relayed edits and
 * deletes".
 */
export interface FederationMessageTarget {
  message: FederationMessageRef;
  /** The conversation's `federatedId` (1-on-1 and group alike). */
  federatedId: string;
  /** The user editing or deleting, as a federated identity. */
  actor: { homeUserId: string; homeInstance: string };
}

export interface FederationRelayReaction {
  messageId?: string;
  messageHomeInstance?: string;
  userId: string;
  homeUserId: string;
  homeInstance: string;
  emoji: string;
  createdAt: number;
}

export interface FederationRelayAttachment {
  id: string;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  // Web-playability computed by the origin instance (see Attachment.playable).
  // Propagated so the receiving instance need not re-probe the codec.
  playable?: boolean | null;
  thumbnailFilename?: string;
  sourceUrl: string;
}

export interface FederationRelayRequest {
  version: 1;
  sourceInstance: string;
  // Sender's persistent epoch (incarnation UUID). Optional for wire compatibility
  // with peers that predate epoch self-healing; when present, the receiver can
  // detect that the source instance has been re-provisioned.
  sourceInstanceId?: string;
  /**
   * Relay behaviours the sender implements beyond plain v1. Optional for wire
   * compatibility: a receiver treats a missing or malformed list as empty and
   * answers with v1 behaviour only. See `FederationRelayCapability`.
   */
  capabilities?: FederationRelayCapability[];
  events: FederationRelayEvent[];
}

/**
 * A relay behaviour a sender opts into by listing it in
 * `FederationRelayRequest.capabilities`. Each one gates something the receiver
 * would otherwise not send, so an older sender is never handed an answer it was
 * not built to handle.
 *
 * - `attribution_unproven`: the sender retries an event rejected with the
 *   reason `attribution_unproven` on its normal backoff, until the outbox TTL.
 *   A receiver may then use that reason for a homeward claim whose proof it
 *   does not hold yet; for any other sender it answers the same case with the
 *   terminal `attribution_mismatch`.
 */
export type FederationRelayCapability = 'attribution_unproven';

export interface FederationEpochResponse {
  instanceId: string;
}

export interface FederationRelayResponse {
  accepted: string[];
  rejected: Array<{ messageId: string; reason: string }>;
  /**
   * Third classification (additive, v1.x): events that were processed cleanly
   * but had no reachable recipient. Distinct from `rejected` (data/protocol
   * refusal). Currently used only for `dm_call_start` — other event types
   * keep accepted/rejected semantics unchanged. Omitted when empty for
   * wire-size hygiene and byte-identical responses in the typical case.
   */
  undeliverable?: Array<{ messageId: string; reason: string }>;
  maxUploadSize: number;
}

export interface FederationSyncRequest {
  sinceTimestamp: number;
  dmChannelId?: string;
  federatedId?: string;
  contextType?: 'dm' | 'friend';
  limit: number;
}

export interface FederationSyncResponse {
  events: FederationRelayEvent[];
  hasMore: boolean;
  checkpoint: number;
}

// Detached-account re-attach (re-attach spec §3.1–3.2).
// Minted on the home instance D for a logged-in native user.
export interface AttachProofResponse {
  token: string;
}

// Body of POST /api/users/@me/reattach on the peer R — the one-time proof token
// minted by the home instance, verified with D over signed S2S.
export interface ReattachRequest {
  token: string;
}

// Success response of POST /api/users/@me/reattach — the re-bound self-view.
export interface ReattachResponse {
  success: true;
  user: User;
}

export interface FederationUserLookupRequest {
  username: string;
}

export interface FederationUserLookupProfile {
  displayName: string | null;
  avatar: string | null;
  avatarColor: AvatarColor | null;
  banner: string | null;
  bio: string | null;
  // Carried so the requester can seed the stub's status at creation time.
  // Optional for backwards compat with peers that pre-date the field.
  status?: 'online' | 'idle' | 'dnd' | 'offline' | null;
}

export type FederationUserLookupResponse =
  | { found: true; user: { homeUserId: string; username: string; profile: FederationUserLookupProfile } }
  | { found: false; code: 'user_not_found' };

export interface FederationPeer {
  id: string;
  origin: string;
  instanceName: string | null;
  status: 'pending' | 'active' | 'unreachable' | 'revoked' | 'rejected' | 'awaiting_approval' | 'needs_attention';
  lastSeenAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  consecutiveAuthFailures: number;
  lastSyncedAt: number;
  autoRotateIntervalDays: number;
  secretRotatedAt: number | null;
  rotationInProgress: boolean;
  createdAt: number;
  needsAttentionReason: 'auth_failures' | 'peer_reset_detected' | 'repeer_incomplete' | null;
}

// ─── Reset-cleanup admin surface (instance-epoch self-healing §6.4) ──────────

/**
 * A real (non-stub) account whose home instance was reset — quarantined via
 * `federation_home_orphaned = 1`. Surfaced to the admin "Reset cleanup" UI with
 * enough context (owned spaces, membership/message counts) to decide Keep or
 * Remove.
 */
export interface FederationOrphanedAccount {
  id: string;
  username: string; // preserved original handle (detach spec); legacy rows may carry '!orphaned:{uid}@domain'
  displayName: string | null;
  avatarColor: string | null;
  ownedSpaces: { id: string; name: string }[];
  spaceMemberCount: number; // # of spaces they're a member of
  messageCount: number; // # of space messages they authored
}

/**
 * A durable row from the `federation_reset_events` journal, augmented with the
 * origin's current orphaned real accounts for admin disposition.
 */
export interface FederationResetEvent {
  origin: string;
  deadEpoch: string;
  newEpoch: string | null;
  detectedAt: number;
  resolvedAt: number | null;
  acknowledgedAt: number | null;
  stubCount: number;
  orphanedAccountCount: number;
  orphanedAccounts: FederationOrphanedAccount[];
}

export interface FederationResetEventsResponse {
  events: FederationResetEvent[];
}

// ─── Outbound peering gate ──────────────────────────────────────────────────

/**
 * Why a user-initiated federation action triggered the outbound peering gate.
 * Recorded on `peer_approval_subscribers.trigger_reason` so admins can see
 * the human-readable cause and the user can recover their original action
 * after approval. Persisted as a string column with this exact set of values.
 *
 * `instance_connect`: the user opened a session on the remote instance
 * (connect, explicit login, token resume, or app start), and the client asked
 * its home instance to peer so DMs written there can be relayed home.
 */
export type PeeringTriggerReason = 'friend_add' | 'space_join' | 'direct_message' | 'instance_connect';

/**
 * The trigger reasons a client may state in `POST /api/federation/peer/ensure`.
 * The server refuses any other value with `validation_failed`, and derives the
 * target itself for each one. `friend_add` is deliberately absent: friend-add
 * peers server-side with a target it has checked, so a client stating it
 * could only put a friend request the admin cannot verify into the queue.
 */
export const PEER_ENSURE_REASONS = ['instance_connect'] as const satisfies readonly PeeringTriggerReason[];
export type PeerEnsureReason = (typeof PEER_ENSURE_REASONS)[number];

/**
 * Body of `POST /api/federation/peer/ensure`. `reason` is optional for clients
 * that predate it; the server reads a missing reason as `instance_connect`,
 * the only thing those clients called the endpoint for.
 */
export interface PeerEnsureRequest {
  remoteOrigin: string;
  reason?: PeerEnsureReason;
}

/**
 * Caller intent passed into `ensurePeered()`. The gate (when
 * `autoAcceptPeering=0` and no peer row exists) branches on `kind`:
 *   - 'user_action': queue an outbound approval request and surface
 *     `admin_required` to the caller so the user sees a clear pending state.
 *   - 'system': skip queueing; surface `admin_required` so the calling
 *     subsystem (e.g. background relay) can fail loudly without spamming
 *     admin queues with rows nobody asked for.
 *
 * `target` is the human-readable target identifier the user acted on
 * (e.g. `username@instance.example` for friend_add, the space invite code
 * for space_join, the federated DM channel id for direct_message, the remote
 * origin for instance_connect).
 */
export type EnsurePeeredCallerIntent =
  | { kind: 'user_action'; userId: string; reason: PeeringTriggerReason; target: string }
  | { kind: 'system' };

/**
 * Terminal-state notification kinds delivered to subscribers when the
 * outbound queue resolves. 'expired' is delivered by the storage janitor
 * before it deletes an unresolved outbound queue row past `expiresAt`.
 */
export type PeeringNotificationKind = 'approved' | 'denied' | 'expired';

/**
 * Per-user pending row joined from `peer_approval_subscribers` to its parent
 * `peer_approval_requests`. Returned from
 * `GET /api/federation/peering-subscriptions`. Used to render the user's own
 * "waiting on admin" surface so they remember which actions are blocked.
 */
export interface PeeringSubscription {
  id: string;
  requestId: string;
  peerOrigin: string;
  peerInstanceName: string | null;
  triggerReason: PeeringTriggerReason;
  triggerTarget: string;
  createdAt: number;
}

/**
 * Terminal-state notification row returned from
 * `GET /api/federation/peering-notifications`. Persists until the user
 * explicitly reads (sets `readAt`) or the janitor cleans up read rows
 * older than the retention window.
 */
export interface PeeringNotification {
  id: string;
  kind: PeeringNotificationKind;
  peerOrigin: string;
  triggerReason: PeeringTriggerReason;
  triggerTarget: string;
  createdAt: number;
  readAt: number | null;
}

/**
 * Subscriber summary embedded in the admin-facing approval request response
 * for outbound rows. Lets the admin see which users are waiting on each
 * outbound request without a separate fetch.
 */
export interface ApprovalRequestSubscriberSummary {
  userId: string;
  username: string;
  triggerReason: PeeringTriggerReason;
  triggerTarget: string;
}

/**
 * Admin-facing approval request row returned from
 * `GET /api/federation/approval-requests`. Inbound rows are remote
 * instances asking to peer with us; outbound rows are local users asking
 * us to peer with a remote instance. Outbound rows include `subscribers`
 * so the admin can see who is waiting.
 */
export interface ApprovalRequest {
  id: string;
  direction: 'inbound' | 'outbound';
  origin: string;
  instanceName: string | null;
  requestedAt: number;
  expiresAt: number;
  /**
   * Subscriber summaries — present (and possibly empty array) only when
   * `direction === 'outbound'`. ABSENT (`undefined`) when `direction === 'inbound'`.
   * Inbound rows have no per-action context; the field is omitted from the server
   * response, not set to `[]`.
   */
  subscribers?: ApprovalRequestSubscriberSummary[];
}
