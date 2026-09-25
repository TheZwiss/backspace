import { PermissionBits } from './permissions';
import type { PermissionKey } from '../components/ui/OverrideEntry';

/**
 * One toggleable permission of a role: the bit itself plus the key its display
 * name is looked up under (via `usePermissionNames()`).
 */
export interface PermDef {
  bit: bigint;
  key: PermissionKey;
}

export type PermissionGroupId = 'general' | 'text' | 'voice';

/**
 * Permission display groups for the role editors. Shared by RolesPanel (space
 * settings) and MemberRolesModal (per-member role editing) so both surfaces
 * show the same permissions, grouped the same way, in the same order.
 */
export const PERMISSION_GROUPS: { id: PermissionGroupId; perms: PermDef[] }[] = [
  {
    id: 'general',
    perms: [
      { bit: PermissionBits.ADMINISTRATOR, key: 'ADMINISTRATOR' },
      { bit: PermissionBits.VIEW_CHANNEL, key: 'VIEW_CHANNEL' },
      { bit: PermissionBits.MANAGE_CHANNELS, key: 'MANAGE_CHANNELS' },
      { bit: PermissionBits.MANAGE_ROLES, key: 'MANAGE_ROLES' },
      { bit: PermissionBits.MANAGE_SPACE, key: 'MANAGE_SPACE' },
      { bit: PermissionBits.CREATE_INVITE, key: 'CREATE_INVITE' },
      { bit: PermissionBits.KICK_MEMBERS, key: 'KICK_MEMBERS' },
      { bit: PermissionBits.BAN_MEMBERS, key: 'BAN_MEMBERS' },
    ],
  },
  {
    id: 'text',
    perms: [
      { bit: PermissionBits.SEND_MESSAGES, key: 'SEND_MESSAGES' },
      { bit: PermissionBits.MANAGE_MESSAGES, key: 'MANAGE_MESSAGES' },
      { bit: PermissionBits.ATTACH_FILES, key: 'ATTACH_FILES' },
      { bit: PermissionBits.READ_MESSAGE_HISTORY, key: 'READ_MESSAGE_HISTORY' },
      { bit: PermissionBits.ADD_REACTIONS, key: 'ADD_REACTIONS' },
    ],
  },
  {
    id: 'voice',
    perms: [
      { bit: PermissionBits.CONNECT, key: 'CONNECT' },
      { bit: PermissionBits.SPEAK, key: 'SPEAK' },
      { bit: PermissionBits.MUTE_MEMBERS, key: 'MUTE_MEMBERS' },
      { bit: PermissionBits.DEAFEN_MEMBERS, key: 'DEAFEN_MEMBERS' },
      { bit: PermissionBits.MOVE_MEMBERS, key: 'MOVE_MEMBERS' },
      { bit: PermissionBits.DISCONNECT_MEMBERS, key: 'DISCONNECT_MEMBERS' },
      { bit: PermissionBits.STREAM, key: 'STREAM' },
    ],
  },
];
