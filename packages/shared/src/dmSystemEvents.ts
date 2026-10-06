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

// ─── http(s) origins ────────────────────────────────────────────────────────
//
// The shared package compiles without DOM or Node types, so the URL global is
// not available here. `isHttpOrigin` applies the URL standard's host rules
// (https://url.spec.whatwg.org/#host-parsing) to the one shape an origin has.

/** Printable ASCII without the standard's forbidden domain code points. */
const DOMAIN_CHARS = /^[!"$&'()*+,\-.0-9;=A-Z_`a-z{}~]+$/;

/** The standard's IPv4 number parser: decimal, `0x` hex or `0` octal; null on failure. */
function ipv4Number(part: string): number | null {
  let digits = part;
  let radix = 10;
  if (/^0x/i.test(digits)) {
    digits = digits.slice(2);
    radix = 16;
  } else if (digits.length > 1 && digits.startsWith('0')) {
    digits = digits.slice(1);
    radix = 8;
  }
  if (digits === '') return part === '' ? null : 0;
  const pattern = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  return pattern.test(digits) ? parseInt(digits, radix) : null;
}

/** The standard's "ends in a number" check: such a host must be an IPv4 address. */
function endsInNumber(parts: string[]): boolean {
  const last = parts[parts.length - 1] ?? '';
  return /^[0-9]+$/.test(last) || ipv4Number(last) !== null;
}

function isIpv4(parts: string[]): boolean {
  if (parts.length > 4) return false;
  const numbers = parts.map(ipv4Number);
  if (numbers.some(n => n === null)) return false;
  const values = numbers as number[];
  if (values.slice(0, -1).some(n => n > 255)) return false;
  return values[values.length - 1]! < 256 ** (5 - values.length);
}

function isDomain(host: string): boolean {
  if (!DOMAIN_CHARS.test(host)) return false;
  const parts = host.split('.');
  if (parts[parts.length - 1] === '') {
    if (parts.length === 1) return false;
    parts.pop();
  }
  return !endsInNumber(parts) || isIpv4(parts);
}

/** The standard's IPv6 parser, without building the address. */
function isIpv6(input: string): boolean {
  const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-f]$/i.test(c);
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
  let pieceIndex = 0;
  let compressed = false;
  let pointer = 0;
  if (input[pointer] === ':') {
    if (input[pointer + 1] !== ':') return false;
    pointer += 2;
    pieceIndex += 1;
    compressed = true;
  }
  while (pointer < input.length) {
    if (pieceIndex === 8) return false;
    if (input[pointer] === ':') {
      if (compressed) return false;
      pointer += 1;
      pieceIndex += 1;
      compressed = true;
      continue;
    }
    let length = 0;
    while (length < 4 && isHex(input[pointer])) {
      pointer += 1;
      length += 1;
    }
    if (input[pointer] === '.') {
      if (length === 0 || pieceIndex > 6) return false;
      pointer -= length;
      let numbersSeen = 0;
      while (pointer < input.length) {
        if (numbersSeen > 0) {
          if (input[pointer] !== '.' || numbersSeen >= 4) return false;
          pointer += 1;
        }
        if (!isDigit(input[pointer])) return false;
        let piece: number | null = null;
        while (isDigit(input[pointer])) {
          const digit = Number(input[pointer]);
          if (piece === 0) return false;
          piece = piece === null ? digit : piece * 10 + digit;
          if (piece > 255) return false;
          pointer += 1;
        }
        numbersSeen += 1;
        if (numbersSeen === 2 || numbersSeen === 4) pieceIndex += 1;
      }
      if (numbersSeen !== 4) return false;
      break;
    }
    if (input[pointer] === ':') {
      pointer += 1;
      if (pointer === input.length) return false;
    } else if (pointer < input.length) {
      return false;
    }
    pieceIndex += 1;
  }
  return compressed || pieceIndex === 8;
}

/**
 * Whether `value` is an http(s) origin, `scheme://host[:port]` with nothing
 * after, that `new URL(value)` accepts: the host is a bracketed IPv6 address,
 * an IPv4 address, or an ASCII domain; the port is digits up to 65535. A
 * non-ASCII host is refused, since an origin as the standard serializes it
 * is ASCII, and `xn--` labels are not checked against Punycode.
 */
export function isHttpOrigin(value: string): boolean {
  const scheme = /^https?:\/\//i.exec(value);
  if (!scheme) return false;
  let rest = value.slice(scheme[0].length);
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0 || !isIpv6(rest.slice(1, close))) return false;
    rest = rest.slice(close + 1);
  } else {
    const colon = rest.indexOf(':');
    if (!isDomain(colon < 0 ? rest : rest.slice(0, colon))) return false;
    rest = colon < 0 ? '' : rest.slice(colon);
  }
  if (rest === '') return true;
  const port = /^:([0-9]+)$/.exec(rest);
  return port !== null && Number(port[1]) <= 65535;
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
