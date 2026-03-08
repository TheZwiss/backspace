import { getDb, schema } from './index.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { hashPassword } from '../utils/auth.js';
import { eq } from 'drizzle-orm';
import { DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@backspace/shared/src/permissions.js';

export async function seedDatabase(): Promise<void> {
  const db = getDb();

  const existingSpaces = db.select().from(schema.spaces).all();
  if (existingSpaces.length > 0) {
    console.log('Database already has data, skipping seed');
    return;
  }

  console.log('Seeding database with default data...');

  const adminId = generateSnowflake();
  const adminPasswordHash = await hashPassword('admin123');

  db.insert(schema.users).values({
    id: adminId,
    username: 'admin',
    displayName: 'Admin',
    passwordHash: adminPasswordHash,
    status: 'offline',
    isAdmin: 1,
    createdAt: Date.now(),
  }).run();

  const spaceId = generateSnowflake();
  db.insert(schema.spaces).values({
    id: spaceId,
    name: 'Backspace',
    ownerId: adminId,
    inviteCode: 'backspace',
    createdAt: Date.now(),
  }).run();

  db.insert(schema.spaceMembers).values({
    spaceId: spaceId,
    userId: adminId,
    joinedAt: Date.now(),
  }).run();

  const generalChannelId = generateSnowflake();
  db.insert(schema.channels).values({
    id: generalChannelId,
    spaceId: spaceId,
    name: 'general',
    type: 'text',
    topic: 'General discussion',
    position: 0,
    createdAt: Date.now(),
  }).run();

  const voiceChannelId = generateSnowflake();
  db.insert(schema.channels).values({
    id: voiceChannelId,
    spaceId: spaceId,
    name: 'General Voice',
    type: 'voice',
    position: 1,
    createdAt: Date.now(),
  }).run();

  // Create @everyone role (id === spaceId convention)
  db.insert(schema.roles).values({
    id: spaceId,
    spaceId: spaceId,
    name: '@everyone',
    color: '#b9bbbe',
    position: 0,
    permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
    createdAt: Date.now(),
  }).run();

  console.log('Database seeded successfully');
  console.log(`  Default space: Backspace (invite code: backspace)`);
  console.log(`  Admin user: admin / admin123`);
}
