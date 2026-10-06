import { AVATAR_COLORS, type AvatarColor, type SpaceInviteSystemPayload } from './types.js';

/**
 * The content of a DM system message (`dm_messages.type = 'system'`), stored
 * as JSON. docs/systems/dm-system.md, "System messages", is the one statement
 * of the rules; in short:
 *
 * - Every instance writes its own membership and metadata rows from the relay
 *   event it applies, so the user ids in them (`targetUserId`, `newOwnerId`)
 *   are always the storing instance's own ids and never cross the wire.
 * - The only system message relayed as a message is `space_invite`, and a
 *   receiver stores it only as `parseDmSystemEvent` returns it.
 * - System messages cannot be edited.
 */
export type DmSystemEvent =
  | { event: 'member_added'; targetUserId: string; targetDisplayName: string }
  | { event: 'member_removed'; targetUserId: string; targetDisplayName: string; reason: 'leave' | 'kick' }
  | { event: 'owner_changed'; newOwnerId: string; newOwnerDisplayName: string }
  | { event: 'name_changed'; oldName: string | null; newName: string | null }
  | { event: 'icon_changed' }
  | SpaceInviteSystemPayload;

/** The system events a peer may relay as a message. */
export const RELAYABLE_DM_SYSTEM_EVENTS: ReadonlySet<DmSystemEvent['event']> = new Set(['space_invite']);

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A string or null; anything else (a missing field included) is `undefined`, which fails the event. */
function optionalText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether `value` is an http(s) origin, `scheme://host[:port]` with nothing
 * after, that `new URL(value)` accepts. URL decides the host and port; the
 * checks before it refuse what URL would take but an origin is not: userinfo,
 * a path, query or fragment (even an empty one), a scheme without `//`, an
 * empty port, and anything URL would strip or decode before parsing (ASCII
 * spaces and controls, `%`), so the value stored is the value that parsed.
 */
export function isHttpOrigin(value: string): boolean {
  const scheme = /^https?:\/\//i.exec(value);
  if (!scheme) return false;
  const authority = value.slice(scheme[0].length);
  // Printable ASCII or non-ASCII; a non-ASCII host is left to URL's IDNA rules.
  if (!/^(?:[!-~]|\P{ASCII})+$/u.test(authority)) return false;
  if (/[/?#@\\%]/.test(authority) || authority.endsWith(':')) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function httpOrigin(value: unknown): string | null {
  const raw = text(value);
  return raw && isHttpOrigin(raw) ? raw : null;
}

function avatarColor(value: unknown): AvatarColor | null {
  return (AVATAR_COLORS as readonly unknown[]).includes(value) ? value as AvatarColor : null;
}

function parseSpaceInvite(data: Fields): SpaceInviteSystemPayload | null {
  const spaceId = text(data.spaceId);
  const spaceInstanceOrigin = httpOrigin(data.spaceInstanceOrigin);
  const inviteCode = text(data.inviteCode);
  const snapshot = data.snapshot;
  if (!spaceId || !spaceInstanceOrigin || !inviteCode || !isFields(snapshot)) return null;

  const spaceName = text(snapshot.spaceName);
  const icon = optionalText(snapshot.icon);
  const description = optionalText(snapshot.description);
  const instanceName = typeof snapshot.instanceName === 'string' ? snapshot.instanceName : null;
  const memberCount = snapshot.memberCount;
  if (!spaceName || icon === undefined || description === undefined || instanceName === null) return null;
  if (typeof memberCount !== 'number' || !Number.isInteger(memberCount) || memberCount < 0) return null;

  return {
    event: 'space_invite',
    spaceId,
    spaceInstanceOrigin,
    inviteCode,
    snapshot: {
      spaceName,
      icon,
      avatarColor: avatarColor(snapshot.avatarColor),
      memberCount,
      description,
      instanceName,
    },
  };
}

/**
 * The system event a message's content holds, or null when it holds none this
 * version knows (not JSON, an unknown event, or a field of the wrong type).
 * The result carries only the fields the event defines, so
 * `JSON.stringify(parseDmSystemEvent(content))` is the content in its
 * canonical form.
 */
export function parseDmSystemEvent(content: string | null | undefined): DmSystemEvent | null {
  if (!content) return null;
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isFields(data)) return null;

  switch (data.event) {
    case 'member_added': {
      const targetUserId = text(data.targetUserId);
      const targetDisplayName = text(data.targetDisplayName);
      return targetUserId && targetDisplayName ? { event: 'member_added', targetUserId, targetDisplayName } : null;
    }
    case 'member_removed': {
      const targetUserId = text(data.targetUserId);
      const targetDisplayName = text(data.targetDisplayName);
      const reason = data.reason === 'leave' || data.reason === 'kick' ? data.reason : null;
      return targetUserId && targetDisplayName && reason
        ? { event: 'member_removed', targetUserId, targetDisplayName, reason }
        : null;
    }
    case 'owner_changed': {
      const newOwnerId = text(data.newOwnerId);
      const newOwnerDisplayName = text(data.newOwnerDisplayName);
      return newOwnerId && newOwnerDisplayName ? { event: 'owner_changed', newOwnerId, newOwnerDisplayName } : null;
    }
    case 'name_changed': {
      const oldName = optionalText(data.oldName);
      const newName = optionalText(data.newName);
      return oldName !== undefined && newName !== undefined ? { event: 'name_changed', oldName, newName } : null;
    }
    case 'icon_changed':
      return { event: 'icon_changed' };
    case 'space_invite':
      return parseSpaceInvite(data);
    default:
      return null;
  }
}
