import { eq } from 'drizzle-orm';
import type { Activity, ActivityAssets, ActivityTimestamps, ActivityType, PresenceIdentity, ServerEvent } from '@backspace/shared';
import { ACTIVITY_LIMITS } from '@backspace/shared/src/activities.js';
import { getDb, schema } from '../db/index.js';

/**
 * The S→C `presence_update` event, built in one place so every emitter names
 * the subject the same way.
 *
 * `userId` is this instance's row id. The row's federated identity rides along
 * (`homeUserId`/`homeInstance`, null for a native row), because the client keys
 * activities by that identity: a replicated row here and the person's native
 * row on their home must land on the same key (#340).
 *
 * Kept free of `connectionManager` so the WS handler, the presence relay and
 * the federation receivers can all import it without an import cycle.
 */
export type PresenceUpdateEvent = Extract<ServerEvent, { type: 'presence_update' }>;

interface IdentityRow {
  homeUserId: string | null;
  homeInstance: string | null;
}

/** The identity a client needs to key a row's presence. Null pair for a native row. */
export function presenceIdentityOf(row: IdentityRow): PresenceIdentity {
  if (!row.homeInstance) return { homeUserId: null, homeInstance: null };
  return { homeUserId: row.homeUserId, homeInstance: row.homeInstance };
}

/**
 * Build a presence_update about a row already in hand. `activities` omitted
 * means "unchanged" to the client; an empty array clears.
 */
export function presenceUpdateEvent(
  subject: { id: string } & IdentityRow,
  status: string,
  activities?: Activity[],
): PresenceUpdateEvent {
  return {
    type: 'presence_update',
    userId: subject.id,
    status,
    ...(activities !== undefined ? { activities } : {}),
    ...presenceIdentityOf(subject),
  };
}

/** Build a presence_update about `userId`, reading its identity from the users table. */
export function presenceUpdateFor(userId: string, status: string, activities?: Activity[]): PresenceUpdateEvent {
  const row = getDb()
    .select({ homeUserId: schema.users.homeUserId, homeInstance: schema.users.homeInstance })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  return presenceUpdateEvent({ id: userId, homeUserId: row?.homeUserId ?? null, homeInstance: row?.homeInstance ?? null }, status, activities);
}

/**
 * The activity set a snapshot reports for a user: their live (or relayed)
 * activities, else their custom status as a `custom` activity. Used by the
 * ready payload and by the friendship snapshot, so both show the same thing.
 */
export function snapshotActivities(live: Activity[], customStatus: string | null): Activity[] {
  if (live.length > 0) return live;
  return customStatus ? [{ type: 'custom', name: customStatus }] : [];
}

// ─── Activity Validation ──────────────────────────────────────────────────

const VALID_ACTIVITY_TYPES = new Set<string>(['custom', 'playing', 'listening', 'watching', 'streaming']);
const MAX_TIMESTAMP = 4102444800000;

/**
 * Validate and normalize an activity list from a client or a peer. Null when
 * anything in it is malformed or over the limits in `ACTIVITY_LIMITS`.
 */
export function validateActivities(raw: unknown): Activity[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > ACTIVITY_LIMITS.MAX_ACTIVITIES_PER_USER) return null;

  const validated: Activity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;
    if (!VALID_ACTIVITY_TYPES.has(obj.type as string)) return null;
    if (typeof obj.name !== 'string') return null;
    // Checked on the trimmed name, which is what is stored and relayed: a
    // name a sender accepts must pass every receiver's check too.
    if (obj.name.trim().length === 0 || obj.name.length > ACTIVITY_LIMITS.MAX_NAME_LENGTH) return null;

    const activity: Activity = { type: obj.type as ActivityType, name: (obj.name as string).trim() };

    if (typeof obj.details === 'string' && obj.details.length <= ACTIVITY_LIMITS.MAX_DETAILS_LENGTH) activity.details = obj.details.trim();
    if (typeof obj.state === 'string' && obj.state.length <= ACTIVITY_LIMITS.MAX_STATE_LENGTH) activity.state = obj.state.trim();
    if (typeof obj.url === 'string' && obj.url.length <= ACTIVITY_LIMITS.MAX_URL_LENGTH) {
      if (obj.url.startsWith('https://') || obj.url.startsWith('http://')) activity.url = obj.url;
    }

    if (obj.timestamps && typeof obj.timestamps === 'object') {
      const tsObj = obj.timestamps as Record<string, unknown>;
      const ts: ActivityTimestamps = {};
      if (typeof tsObj.start === 'number' && tsObj.start >= 0 && tsObj.start <= MAX_TIMESTAMP) ts.start = tsObj.start;
      if (typeof tsObj.end === 'number' && tsObj.end >= 0 && tsObj.end <= MAX_TIMESTAMP) ts.end = tsObj.end;
      if (ts.start !== undefined || ts.end !== undefined) activity.timestamps = ts;
    }

    if (obj.assets && typeof obj.assets === 'object') {
      const aObj = obj.assets as Record<string, unknown>;
      const assets: ActivityAssets = {};
      if (typeof aObj.largeImage === 'string' && aObj.largeImage.length <= ACTIVITY_LIMITS.MAX_URL_LENGTH) assets.largeImage = aObj.largeImage;
      if (typeof aObj.largeText === 'string' && aObj.largeText.length <= ACTIVITY_LIMITS.MAX_ASSET_TEXT_LENGTH) assets.largeText = aObj.largeText;
      if (typeof aObj.smallImage === 'string' && aObj.smallImage.length <= ACTIVITY_LIMITS.MAX_URL_LENGTH) assets.smallImage = aObj.smallImage;
      if (typeof aObj.smallText === 'string' && aObj.smallText.length <= ACTIVITY_LIMITS.MAX_ASSET_TEXT_LENGTH) assets.smallText = aObj.smallText;
      if (Object.keys(assets).length > 0) activity.assets = assets;
    }

    validated.push(activity);
  }
  return validated;
}
