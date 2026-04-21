# WebSocket Protocol Reference

Endpoint: `GET /ws` (upgrade to WebSocket)
Transport: JSON messages over WebSocket
Source: `packages/server/src/ws/handler.ts`, `packages/server/src/ws/events.ts`

---

## Auth Flow

1. Client connects to `/ws`
2. Client sends `{ type: 'auth', token: '<jwt>' }` within 10 seconds
3. Server validates token (rejects deleted users, tokens issued before `passwordChangedAt`)
4. Server responds with `ready` event containing full client state
5. Server updates user status to `online`, broadcasts `presence_update` to all user's spaces
6. Heartbeat: server pings every 30s (RFC 6455 ping frames), dead connections detected after ~65s

---

## Client → Server

### Messages
| type | fields | notes |
|------|--------|-------|
| `message_create` | channelId, content, replyToId? | SEND_MESSAGES perm |
| `message_edit` | messageId, content | author only |
| `message_delete` | messageId | author or MANAGE_MESSAGES |
| `typing_start` | channelId | 5s auto-expire |

### DM Messages
| type | fields | notes |
|------|--------|-------|
| `dm_message_create` | dmChannelId, content?, attachments?, replyToId? | member |
| `dm_message_edit` | messageId, content | author only |
| `dm_message_delete` | messageId | author only |
| `dm_typing_start` | dmChannelId | 5s auto-expire |

### Reactions (space + DM, auto-detected)
| type | fields | notes |
|------|--------|-------|
| `reaction_add` | messageId, emoji | ADD_REACTIONS perm (space) |
| `reaction_remove` | messageId, emoji | own reactions only |

### Read State
| type | fields | notes |
|------|--------|-------|
| `channel_ack` | channelId, messageId | mark read up to message |
| `mark_unread` | channelId, messageId | `'0'` to clear all |

### Presence & Activity
| type | fields | notes |
|------|--------|-------|
| `presence_update` | status: online/idle/dnd | persisted to DB |
| `activity_update` | activities: Activity[] | rate-limited 3s, respects showActivity |

### Voice (Space Channels)
| type | fields | notes |
|------|--------|-------|
| `voice_join` | channelId | one room per user enforced |
| `voice_leave` | — | |
| `voice_status` | isMuted, isDeafened, isCameraOn, isScreenSharing | server enforces space/permission mute |

### Voice Moderation
| type | fields | permission |
|------|--------|------------|
| `voice_space_mute` | userId, muted | MUTE_MEMBERS |
| `voice_space_deafen` | userId, deafened | DEAFEN_MEMBERS |
| `voice_move` | userId, targetChannelId | MOVE_MEMBERS |
| `voice_disconnect` | userId | DISCONNECT_MEMBERS |

### DM Calls
| type | fields | notes |
|------|--------|-------|
| `dm_call_start` | dmChannelId?, federatedCallId? | `dmChannelId` can be null when `federatedCallId` is provided. 60s auto-timeout if not accepted |
| `dm_call_accept` | dmChannelId?, federatedCallId? | ringing→active |
| `dm_call_reject` | dmChannelId?, federatedCallId? | |
| `dm_call_end` | dmChannelId?, federatedCallId? | |

### System
| type | fields |
|------|--------|
| `auth` | token |
| `ping` | — (gets `pong`) |

---

## Server → Client

### System
| type | fields | scope |
|------|--------|-------|
| `ready` | (see Ready Payload below) | user |
| `pong` | — | user |
| `error` | message | user |

### Messages
| type | fields | scope |
|------|--------|-------|
| `message_created` | message: MessageWithUser | channel (VIEW_CHANNEL) |
| `message_updated` | message: MessageWithUser | channel |
| `message_deleted` | messageId, channelId | channel |
| `typing` | channelId, userId, username | channel (excludes sender) |
| `reaction_added` | messageId, reaction (includes user) | channel |
| `reaction_removed` | messageId, userId, emoji | channel |
| `embeds_resolved` | messageId, channelId, embeds[] | channel |

### DM Messages
| type | fields | scope |
|------|--------|-------|
| `dm_message_created` | message: DmMessageWithUser | DM members |
| `dm_message_updated` | message: DmMessageWithUser | DM members |
| `dm_message_deleted` | messageId, dmChannelId | DM members |
| `dm_typing` | dmChannelId, userId, username | DM members (excludes sender) |
| `dm_typing_stop` | dmChannelId, userId | DM members (excludes typer) |
| `dm_embeds_resolved` | messageId, dmChannelId, embeds[] | DM members |

### Read State
| type | fields | scope |
|------|--------|-------|
| `channel_ack` | channelId, messageId | user (multi-tab sync) |
| `mark_unread` | channelId, messageId | user (multi-tab sync) |

### Presence & Activity
| type | fields | scope |
|------|--------|-------|
| `presence_update` | userId, status, activities? | space (all members) |
| `user_updated` | user | user |

### Space / Channel Management
| type | fields | scope |
|------|--------|-------|
| `space_updated` | space | space |
| `member_joined` | spaceId, member: MemberWithUser | space |
| `member_left` | spaceId, userId | space |
| `member_banned` | spaceId, reason | user (banned) |
| `channel_created` | channel, spaceId | space |
| `channel_updated` | channel, spaceId | space |
| `channel_deleted` | channelId, spaceId | space |
| `category_created` | category, spaceId | space |
| `category_updated` | category, spaceId | space |
| `category_deleted` | categoryId, spaceId | space |
| `channel_layout_updated` | spaceId, channels[], categories[] | space |
| `space_layout_updated` | layout[], folders[], updatedAt? | user |

### DM Channel Management
| type | fields | scope |
|------|--------|-------|
| `dm_channel_created` | dmChannel | user |
| `dm_channel_closed` | dmChannelId | user |
| `dm_member_added` | dmChannelId, user | DM members |
| `dm_member_removed` | dmChannelId, userId | DM members |
| `dm_owner_updated` | dmChannelId, newOwnerId | DM members |

### Voice
| type | fields | scope |
|------|--------|-------|
| `voice_state_update` | channelId, userId, action: join/leave | space |
| `voice_status_update` | userId, channelId, isMuted, isDeafened, isCameraOn, isScreenSharing | room |
| `voice_space_muted` | userId, channelId, spaceId, muted | space |
| `voice_space_deafened` | userId, channelId, spaceId, deafened | space |
| `voice_permission_muted` | userId, spaceId, muted | space |
| `voice_moved` | userId, oldChannelId, newChannelId | user (target) |
| `voice_disconnected` | userId, channelId, reason? | user (target) |
reason: `'displaced'` (new tab) | `'session_closed'`

### DM Calls
| type | fields | scope |
|------|--------|-------|
| `dm_call_incoming` | dmChannelId?, federatedCallId, callerId, callerName, callOrigin?, livekitUrl?, livekitToken? | DM members (excludes caller). `dmChannelId` can be null for Path B federated calls (no local DM channel). `callOrigin` identifies the hosting instance for cross-instance calls. |
| `dm_call_accepted` | dmChannelId?, federatedCallId? | DM members |
| `dm_call_rejected` | dmChannelId?, federatedCallId? | DM members |
| `dm_call_ended` | dmChannelId?, federatedCallId? | DM members |
| `dm_call_undeliverable` | Sent to caller when a call-start relay to one or more targeted peers fails. `failures[]` enumerates each failed peer with a `reason` (`peer_rejected` / `peer_awaiting_approval` / `peer_transient_failure` / `livekit_unavailable`). `terminal: true` means the local ring was destroyed; `false` means the call continues for reachable recipients. | caller only |

### Social
| type | fields | scope |
|------|--------|-------|
| `friend_request_received` | request | user (target) |
| `friend_request_accepted` | friend, requestId | user (requester) |
| `friend_request_declined` | requestId, userId | user (requester) |
| `friend_request_cancelled` | requestId, userId | user (target) |
| `friend_removed` | userId | user |

### Discovery
| type | fields | scope |
|------|--------|-------|
| `join_request_received` | request | space (managers) |
| `join_request_accepted` | request, space | user (requester) |
| `join_request_declined` | request | user (requester) |

### Federation
| type | fields | scope |
|------|--------|-------|
| `federation_file_rejected` | messageId, dmChannelId, attachmentId, affectedUsers[] | DM members |

**S2S relay-only event (not a direct client WS event):**

`read_state_update` — sent peer-to-peer via the federation relay when a user acknowledges a DM channel on one instance. The receiving instance processes it, upserts the `read_states` row, and then emits a standard `channel_ack` event to the user's local WebSocket connections. The relay event itself is never forwarded to clients directly.

---

## Ready Payload

```typescript
{
  type: 'ready',
  user: User,
  spaces: SpaceWithChannelsAndMembers[],
  dmChannels: DmChannel[],
  folders?: SpaceFolder[],
  spaceLayout?: SpaceLayoutItem[] | null,
  layoutUpdatedAt?: number,
  voiceStates?: Record<channelId, userId[]>,
  voiceUserStates?: Record<string, { isMuted, isDeafened, isCameraOn, isScreenSharing }>,
  spaceVoiceStates?: Record<string, { spaceMuted, spaceDeafened, permissionMuted }>,
  readStates?: ReadState[],
  activeCalls?: ActiveCallInfo[],  // includes federatedCallHost?, livekitUrl?, livekitToken? for federated calls
  userActivities?: Record<userId, Activity[]>,
  rejectedPeerOrigins: string[],         // origins with status 'rejected'; used for DM unreachable indicators
  awaitingApprovalPeerOrigins: string[], // origins with status 'awaiting_approval'
  pendingApprovalCount: number           // count of peer_approval_requests rows; only non-zero for admins
}
```

**Federation filtering:** When the connecting user is federated (`homeInstance` is set), the server omits all DM-related data from the ready payload. `dmChannels` and `activeCalls` are sent as empty arrays, and `readStates` is filtered to only include space channel entries. Federated users receive their DM data from their home instance's ready payload instead.
