import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';

// A space with one member of each audience the role and override shaping
// distinguishes (docs/systems/permissions.md, "Who receives role and override
// data"). Shared by ws/readyPayload.roleScope.test.ts and
// routes/rolePayloadScope.test.ts.

export type FixtureDb = ReturnType<typeof drizzle<typeof schema>>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const NOW = 1_700_000_000_000;
export const SPACE_ID = 'space-roles';
export const REQUEST_SPACE_ID = 'space-request';
export const CATEGORY_ID = 'cat-staff';
export const GENERAL_ID = 'ch-general';
export const PRIVATE_ID = 'ch-private';

export const EVERYONE_BITS = PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES | PermissionBits.READ_MESSAGE_HISTORY;
export const ADMIN_ROLE_BITS = PermissionBits.ADMINISTRATOR;
export const MOD_ROLE_BITS = PermissionBits.MANAGE_ROLES | PermissionBits.KICK_MEMBERS;
export const CHANNEL_ROLE_BITS = PermissionBits.MANAGE_CHANNELS;
export const VIP_ROLE_BITS = PermissionBits.ATTACH_FILES;
/** What the VIP role's override on the private channel and its category allows. */
export const VIP_OVERRIDE_ALLOW = PermissionBits.VIEW_CHANNEL | PermissionBits.MANAGE_MESSAGES;

/** Members by audience, plus one user who belongs to no space. */
export const USERS = {
  owner: 'u-owner',
  instanceAdmin: 'u-instance-admin',
  administrator: 'u-administrator',
  manager: 'u-manager',
  channelManager: 'u-channel-manager',
  vip: 'u-vip',
  member: 'u-member',
  outsider: 'u-outsider',
} as const;

export const ROLE_BITS: Record<string, bigint> = {
  [SPACE_ID]: EVERYONE_BITS,
  'r-admin': ADMIN_ROLE_BITS,
  'r-mod': MOD_ROLE_BITS,
  'r-channels': CHANNEL_ROLE_BITS,
  'r-vip': VIP_ROLE_BITS,
};

export function openFixtureDatabase(): { sqlite: Database.Database; db: FixtureDb } {
  const sqlite = new Database(':memory:');
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) sqlite.exec(clean);
    }
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function addUser(db: FixtureDb, id: string, isAdmin = 0): void {
  db.insert(schema.users).values({
    id, username: id, passwordHash: 'x', homeUserId: id, homeInstance: null, isAdmin, createdAt: NOW,
  }).run();
}

function addMember(db: FixtureDb, spaceId: string, userId: string, roleId?: string): void {
  db.insert(schema.spaceMembers).values({ spaceId, userId, joinedAt: NOW }).run();
  if (roleId) db.insert(schema.memberRoles).values({ spaceId, userId, roleId }).run();
}

/**
 * The public space `SPACE_ID`: @everyone, ADMINISTRATOR, MANAGE_ROLES,
 * MANAGE_CHANNELS and a VIP role; a general channel and a private one in a
 * category, where @everyone is denied VIEW_CHANNEL and the VIP role allowed it
 * (on the channel and on the category). And the request-only space
 * `REQUEST_SPACE_ID`, owned by the same owner, which only the owner belongs to.
 */
export function seedRolePayloadSpaces(db: FixtureDb): void {
  for (const id of Object.values(USERS)) addUser(db, id, id === USERS.instanceAdmin ? 1 : 0);

  db.insert(schema.spaces).values([
    { id: SPACE_ID, name: 'Roles', ownerId: USERS.owner, inviteCode: 'inv-roles', visibility: 'public', createdAt: NOW },
    { id: REQUEST_SPACE_ID, name: 'Ask first', ownerId: USERS.owner, inviteCode: 'inv-request', visibility: 'request', createdAt: NOW },
  ]).run();

  db.insert(schema.roles).values([
    { id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', color: '#b9bbbe', position: 0, permissions: permissionsToString(EVERYONE_BITS), createdAt: NOW },
    { id: 'r-admin', spaceId: SPACE_ID, name: 'Admins', color: '#ff0000', position: 4, permissions: permissionsToString(ADMIN_ROLE_BITS), createdAt: NOW },
    { id: 'r-mod', spaceId: SPACE_ID, name: 'Mods', color: '#00ff00', position: 3, permissions: permissionsToString(MOD_ROLE_BITS), createdAt: NOW },
    { id: 'r-channels', spaceId: SPACE_ID, name: 'Channel keepers', color: '#00ffff', position: 2, permissions: permissionsToString(CHANNEL_ROLE_BITS), createdAt: NOW },
    { id: 'r-vip', spaceId: SPACE_ID, name: 'VIP', color: '#0000ff', position: 1, permissions: permissionsToString(VIP_ROLE_BITS), createdAt: NOW },
    { id: REQUEST_SPACE_ID, spaceId: REQUEST_SPACE_ID, name: '@everyone', color: '#b9bbbe', position: 0, permissions: permissionsToString(EVERYONE_BITS), createdAt: NOW },
  ]).run();

  addMember(db, SPACE_ID, USERS.owner);
  addMember(db, SPACE_ID, USERS.instanceAdmin);
  addMember(db, SPACE_ID, USERS.administrator, 'r-admin');
  addMember(db, SPACE_ID, USERS.manager, 'r-mod');
  addMember(db, SPACE_ID, USERS.channelManager, 'r-channels');
  addMember(db, SPACE_ID, USERS.vip, 'r-vip');
  addMember(db, SPACE_ID, USERS.member);
  addMember(db, REQUEST_SPACE_ID, USERS.owner);

  db.insert(schema.channelCategories).values({ id: CATEGORY_ID, spaceId: SPACE_ID, name: 'staff', position: 0, createdAt: NOW }).run();
  db.insert(schema.channels).values([
    { id: GENERAL_ID, spaceId: SPACE_ID, name: 'general', type: 'text', position: 0, categoryId: null, createdAt: NOW },
    { id: PRIVATE_ID, spaceId: SPACE_ID, name: 'private', type: 'text', position: 1, categoryId: CATEGORY_ID, createdAt: NOW },
  ]).run();

  const deny = permissionsToString(PermissionBits.VIEW_CHANNEL);
  const allow = permissionsToString(VIP_OVERRIDE_ALLOW);
  db.insert(schema.channelOverrides).values([
    { channelId: PRIVATE_ID, targetType: 'role', targetId: SPACE_ID, allow: '0', deny },
    { channelId: PRIVATE_ID, targetType: 'role', targetId: 'r-vip', allow, deny: '0' },
  ]).run();
  db.insert(schema.categoryOverrides).values([
    { categoryId: CATEGORY_ID, targetType: 'role', targetId: SPACE_ID, allow: '0', deny },
    { categoryId: CATEGORY_ID, targetType: 'role', targetId: 'r-vip', allow, deny: '0' },
  ]).run();
}

/**
 * Users whose home is another instance, as `addReplicatedMember` takes them.
 * The manager's id at home is the same string as a local plain member's id,
 * so a check that compared bare ids across instances would mix the two up.
 */
export const REPLICATED = {
  manager: { id: 'u-replica-manager', homeUserId: USERS.member, homeInstance: 'peer.example' },
  member: { id: 'u-replica-member', homeUserId: 'u-home-member', homeInstance: 'peer.example' },
} as const;

/**
 * A user whose home is another instance, replicated here under a local id
 * that differs from their id at home, and made a member of `spaceId` (with
 * `roleId` when given). This is how a remote user connected to this instance
 * is a member of its spaces.
 */
export function addReplicatedMember(
  db: FixtureDb,
  spaceId: string,
  user: { id: string; homeUserId: string; homeInstance: string },
  roleId?: string,
): void {
  db.insert(schema.users).values({
    id: user.id, username: user.id, passwordHash: 'x', homeUserId: user.homeUserId, homeInstance: user.homeInstance, createdAt: NOW,
  }).run();
  addMember(db, spaceId, user.id, roleId);
}

/** The stored permissions string of a fixture role, as a manager receives it. */
export function storedBitsOf(roleId: string): string {
  const bits = ROLE_BITS[roleId];
  if (bits === undefined) throw new Error(`no fixture role ${roleId}`);
  return permissionsToString(bits);
}
