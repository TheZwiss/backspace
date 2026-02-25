import { getDb, schema } from './index.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { hashPassword } from '../utils/auth.js';
import { eq } from 'drizzle-orm';
import { DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@opencord/shared/src/permissions.js';

export async function seedDatabase(): Promise<void> {
  const db = getDb();

  const existingServers = db.select().from(schema.servers).all();
  if (existingServers.length > 0) {
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
    createdAt: Date.now(),
  }).run();

  const serverId = generateSnowflake();
  db.insert(schema.servers).values({
    id: serverId,
    name: 'Opencord',
    ownerId: adminId,
    inviteCode: 'opencord',
    createdAt: Date.now(),
  }).run();

  db.insert(schema.serverMembers).values({
    serverId: serverId,
    userId: adminId,
    joinedAt: Date.now(),
  }).run();

  const generalChannelId = generateSnowflake();
  db.insert(schema.channels).values({
    id: generalChannelId,
    serverId: serverId,
    name: 'general',
    type: 'text',
    topic: 'General discussion',
    position: 0,
    createdAt: Date.now(),
  }).run();

  const voiceChannelId = generateSnowflake();
  db.insert(schema.channels).values({
    id: voiceChannelId,
    serverId: serverId,
    name: 'General Voice',
    type: 'voice',
    position: 1,
    createdAt: Date.now(),
  }).run();

  // Create @everyone role (id === serverId convention)
  db.insert(schema.roles).values({
    id: serverId,
    serverId: serverId,
    name: '@everyone',
    color: '#b9bbbe',
    position: 0,
    permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
    createdAt: Date.now(),
  }).run();

  console.log('Database seeded successfully');
  console.log(`  Default server: Opencord (invite code: opencord)`);
  console.log(`  Admin user: admin / admin123`);
}
