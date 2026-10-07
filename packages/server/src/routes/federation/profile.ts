import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { getDb, schema } from '../../db/index.js';
import { deleteUploadFile } from '../../utils/fileCleanup.js';
import { sanitizeUser } from '../../utils/sanitize.js';
import { generateSnowflake } from '../../utils/snowflake.js';
import { collectProfileBroadcastTargetIds } from '../../utils/userDeletion.js';
import { safeFetch } from '../../utils/ssrf.js';
import { connectionManager } from '../../ws/handler.js';
import { and, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FederationRelayEvent, FederationRelayProfileSnapshot, FederationUserLookupProfile } from '@backspace/shared';
import { extractDomain, resolveRelayActor } from './identity.js';
import { announceUserUpdated, applyPlaceholderRename, handleFromHint } from './stubName.js';

/**
 * Hydrate a replicated user stub with profile data from a relay event.
 * The snapshot carries no version, and a DM or friend event may carry one
 * that a third instance built from its own, possibly stale, replica of the
 * user, so it cannot tell whether it is newer than what is stored. Hydration
 * therefore only fills profile columns that are empty, and only on a row the
 * home has not yet answered with a version (`profile_updated_at` is null);
 * once it has, the home's profile (`applyHomeProfile`) stands as written,
 * empty columns included. Both conditions are checked in the UPDATE, not on
 * the row passed in, so a home answer that lands while images download wins.
 * The one rewrite is the username of a row with a placeholder name or a
 * `~<n>` name for the same handle (`applyPlaceholderRename`), which follows
 * the handle rules, not this one.
 *
 * When the row changed (renamed, or a field filled), the users who can see it
 * get one `user_updated` with the row as stored (`announceUserUpdated`), after
 * every field is written. Returns the row as stored. A rename just before by
 * `resolveOrCreateReplicatedUser` announced the row without the display name
 * this fills, so this is the event that carries it.
 */
export async function hydrateReplicatedUserProfile(
  userIn: typeof schema.users.$inferSelect,
  profile: FederationRelayProfileSnapshot | undefined,
  db: ReturnType<typeof getDb>,
): Promise<typeof schema.users.$inferSelect> {
  if (!profile) return userIn;
  if (!userIn.homeInstance) return userIn; // Don't update native users
  // Detached accounts are sovereign local accounts: the home domain now belongs
  // to a different incarnation, so a relayed snapshot resolved via an old
  // homeUserId (tier-1 historical hit) must never fill this row's fields. No-op
  // return, mirroring the profile_update / presence_update / identity-delete
  // guards (detach spec §4.3).
  if (userIn.federationHomeOrphaned === 1) return userIn;

  // A row still carrying a placeholder name takes the snapshot's username.
  const user = applyPlaceholderRename(userIn, profile.username, db);
  const renamed = user !== userIn;

  const homeInstance = userIn.homeInstance;
  const baseUrl = homeInstance.startsWith('http') ? homeInstance : `https://${homeInstance}`;
  const buildAbsoluteUrl = (value: string): string => {
    if (value.startsWith('http')) return value;
    const path = value.startsWith('/') ? value : `/api/uploads/${value}`;
    return `${baseUrl}${path}`;
  };

  // Resolve a snapshot asset to a local filename (preferred) or, on download
  // failure, fall back to the absolute URL so the avatar still renders while
  // the home instance is reachable.
  const resolveAsset = async (snapshot: string): Promise<string> => {
    const absoluteUrl = buildAbsoluteUrl(snapshot);
    const localFile = await downloadProfileAsset(absoluteUrl, baseUrl);
    return localFile ?? absoluteUrl;
  };

  const fills: Partial<Record<FillColumn, string>> = {};
  // A row with a home version takes its profile from the home only, so there
  // is nothing to fill or download. The UPDATE checks this again at write time.
  const homeAnswered = user.profileUpdatedAt !== null;
  // Use displayName from profile, falling back to the handle the snapshot
  // names. Senders put the handle there (`relayHandleOf`); an older sender put
  // its own row name (`kai@host`, `kai~1@host`), which is not a name to show,
  // so only a handle-shaped value counts (`handleFromHint`).
  const effectiveDisplayName = profile.displayName || handleFromHint(profile.username);
  // Hydrate is best-effort: only fill empty fields. Never overwrite an
  // existing value: that is exclusively applyHomeProfile's job (it carries a
  // monotonic version and comes from the home). Overwriting from an
  // unversioned snapshot let a third instance's stale replica flip a field
  // back and forth, announcing each flip. Locally-downloaded bare filenames
  // produced by that path must not be clobbered back to URLs either.
  if (!homeAnswered) {
    if (effectiveDisplayName && !user.displayName) fills.displayName = effectiveDisplayName;
    if (profile.avatar && !user.avatar) fills.avatar = await resolveAsset(profile.avatar);
    if (profile.avatarColor && !user.avatarColor) fills.avatarColor = profile.avatarColor;
    if (profile.banner && !user.banner) fills.banner = await resolveAsset(profile.banner);
    if (profile.bio && !user.bio) fills.bio = profile.bio;
  }

  const columns = Object.keys(fills) as FillColumn[];
  if (columns.length === 0) {
    if (renamed) announceUserUpdated(user);
    return user;
  }

  // The row was read before the images downloaded, and the home's answer to
  // the creation pull (`scheduleHomeRecordPull`) or a `profile_update` may
  // have written it since. Whether the home has answered and which columns
  // are empty are therefore decided in the write itself, so the home's
  // profile written meanwhile stands, empty columns included.
  const set: Partial<Record<FillColumn, SQL>> = {};
  for (const column of columns) {
    set[column] = sql`COALESCE(NULLIF(${schema.users[column]}, ''), ${fills[column]})`;
  }
  db.update(schema.users)
    .set(set)
    .where(and(eq(schema.users.id, user.id), isNull(schema.users.profileUpdatedAt)))
    .run();

  const stored = db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  // A downloaded image that did not land (the home answered, or the column
  // was filled meanwhile) is nobody's file.
  for (const column of ['avatar', 'banner'] as const) {
    const file = fills[column];
    if (file && !file.startsWith('http') && stored?.[column] !== file) deleteUploadFile(file);
  }
  if (!stored) return user;

  const filled = columns.some(column => stored[column] === fills[column] && user[column] !== fills[column]);
  if (renamed || filled) announceUserUpdated(stored);
  return stored;
}

/** The columns fill-empty hydration (`hydrateReplicatedUserProfile`) may fill. */
type FillColumn = 'displayName' | 'avatar' | 'avatarColor' | 'banner' | 'bio';


/**
 * Cap on a replicated avatar or banner. Peers are admin-approved but explicitly
 * untrusted; without a cap a peer answers the download with an unbounded body
 * and fills the instance's disk. 8 MiB is well above any real avatar and well
 * below anything that matters on a volume.
 */
export const MAX_PROFILE_ASSET_BYTES = 8 * 1024 * 1024;

/**
 * Download a profile image (avatar or banner) from a remote instance.
 * Returns the local filename on success, or null on failure.
 * On failure, the caller stores the absolute URL as a display fallback.
 */
export async function downloadProfileAsset(
  url: string,
  sourceInstance: string,
): Promise<string | null> {
  // SSRF: hostname must match the authenticated source instance
  try {
    const urlHostname = new URL(url).hostname;
    const sourceHostname = new URL(sourceInstance).hostname;
    if (urlHostname !== sourceHostname) {
      console.warn(`[federation] Profile asset SSRF blocked: URL hostname "${urlHostname}" != source "${sourceHostname}"`);
      return null;
    }
  } catch {
    return null;
  }

  const ext = path.extname(new URL(url).pathname) || '.webp';
  const localId = generateSnowflake();
  const finalFilename = `${localId}${ext}`;
  const tempFilename = `temp_${localId}${ext}`;
  const tempPath = path.join(config.uploadDir, tempFilename);
  const finalPath = path.join(config.uploadDir, finalFilename);

  try {
    // safeFetch, not fetch: the hostname check above constrains the FIRST hop
    // only, and bare fetch follows redirects without re-checking. safeFetch
    // re-validates every hop, so a 302 into the local network is refused.
    const response = await safeFetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok || !response.body) {
      return null;
    }

    // Content-type must be an image
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      console.warn(`[federation] Profile asset rejected: non-image content-type "${contentType}" from ${url}`);
      return null;
    }

    // Content-Length is a claim, not a guarantee, but when it is present and
    // already over the cap there is no reason to open the file at all.
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_PROFILE_ASSET_BYTES) {
      console.warn(`[federation] Profile asset rejected: declared ${declared} bytes exceeds cap`);
      return null;
    }

    // Ensure upload directory exists
    fs.mkdirSync(config.uploadDir, { recursive: true });

    // Stream to temp file, counting bytes, so the cap is enforced on what
    // actually arrives rather than on what the peer said it would send. The
    // controller.error() below rejects the pipeline, and the catch block
    // removes the partial temp file.
    let received = 0;
    const capped = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_PROFILE_ASSET_BYTES) {
          controller.error(new Error('Profile asset exceeds size cap'));
          return;
        }
        controller.enqueue(chunk);
      },
    });

    const nodeStream = Readable.fromWeb(response.body.pipeThrough(capped) as ReadableStream);
    const writeStream = fs.createWriteStream(tempPath);
    await pipeline(nodeStream, writeStream);

    // Atomic rename
    fs.renameSync(tempPath, finalPath);

    return finalFilename;
  } catch (err) {
    // Clean up temp file on any failure
    try { fs.unlinkSync(tempPath); } catch { /* may not exist */ }
    console.warn('[federation] Profile asset download failed for %s:', url, (err as Error).message);
    return null;
  }
}


type UserRow = typeof schema.users.$inferSelect;

/**
 * A user's profile as their home reports it: a `profile_update` payload or a
 * `/users/by-home-id` answer. `profileUpdatedAt` is the home's version; null
 * when the home sent none (an older home's by-home-id answer). `accentColor`
 * undefined means the home did not say (an older home's answer), and the
 * stored value is kept. `username` is the home handle.
 */
export interface HomeProfile {
  profileUpdatedAt: number | null;
  username: string | null;
  displayName: string | null;
  avatar: string | null;
  banner: string | null;
  accentColor?: string | null;
  avatarColor: string | null;
  bio: string | null;
}

/** A `/users/by-home-id` answer's profile as a `HomeProfile`. */
export function homeProfileFromAnswer(answer: { username: string; profile: FederationUserLookupProfile }): HomeProfile {
  const { profile } = answer;
  return {
    profileUpdatedAt: profile.profileUpdatedAt ?? null,
    username: answer.username,
    displayName: profile.displayName,
    avatar: profile.avatar,
    banner: profile.banner,
    ...(profile.accentColor !== undefined ? { accentColor: profile.accentColor } : {}),
    avatarColor: profile.avatarColor,
    bio: profile.bio,
  };
}

/**
 * Whether a home profile at version `incoming` replaces what a row stores at
 * `stored`. A version replaces no version and any older one. No version (an
 * older home) replaces only no version: it cannot be ordered against one.
 */
function isNewerHomeProfile(incoming: number | null, stored: number | null): boolean {
  if (incoming === null) return stored === null;
  return stored === null || incoming > stored;
}

/**
 * Resolve a profile image the home names (an absolute URL, or a bare filename
 * on the home) to a local copy, or to the absolute URL when the download
 * fails, so it still renders while the home is reachable.
 */
async function resolveHomeAsset(value: string | null, homeOrigin: string): Promise<string | null> {
  if (!value) return null;
  const baseUrl = homeOrigin.startsWith('http') ? homeOrigin : `https://${homeOrigin}`;
  const absoluteUrl = value.startsWith('http') ? value : `${baseUrl}/api/uploads/${value}`;
  return (await downloadProfileAsset(absoluteUrl, baseUrl)) ?? absoluteUrl;
}

/**
 * Apply a user's profile as their home reports it (`HomeProfile`) to the row
 * homed there, and return the row as stored afterwards. The one writer of a
 * remote user's profile besides fill-empty hydration: a `profile_update`
 * (`processProfileUpdateEvent`), and every by-home-id answer (the pull when a
 * row is created, the peer-activation pass, client DM routes, re-attach).
 *
 * Applies only a newer version (`isNewerHomeProfile`), checked again in the
 * write itself, so a slower answer that lost the race to a newer one while its
 * images downloaded changes nothing (its downloads are removed). Overwrites
 * displayName (falling back to the handle, never a row name), avatar, banner,
 * accentColor (unless not given), avatarColor, bio and the version. Replaced
 * local image files are removed. Never renames the row. The users who can see
 * the row, and the row's own sessions, get one `user_updated`.
 *
 * Native rows and detached rows (`federation_home_orphaned = 1`) are returned
 * unchanged: a detached account's home domain now belongs to another
 * incarnation, which never writes its profile.
 */
export async function applyHomeProfile(
  row: UserRow,
  profile: HomeProfile,
  homeOrigin: string,
  db: ReturnType<typeof getDb>,
): Promise<UserRow> {
  if (!row.homeInstance || row.federationHomeOrphaned === 1) return row;
  if (!isNewerHomeProfile(profile.profileUpdatedAt, row.profileUpdatedAt)) return row;

  const avatar = await resolveHomeAsset(profile.avatar, homeOrigin);
  const banner = await resolveHomeAsset(profile.banner, homeOrigin);

  const updates: Partial<typeof schema.users.$inferInsert> = {
    displayName: profile.displayName ?? handleFromHint(profile.username),
    avatar,
    banner,
    avatarColor: profile.avatarColor,
    bio: profile.bio,
    profileUpdatedAt: profile.profileUpdatedAt,
  };
  if (profile.accentColor !== undefined) updates.accentColor = profile.accentColor;

  // The version is checked again in the write: another apply for this row may
  // have written a newer one while the images downloaded.
  const versionStillNewer = profile.profileUpdatedAt === null
    ? isNull(schema.users.profileUpdatedAt)
    : or(isNull(schema.users.profileUpdatedAt), lt(schema.users.profileUpdatedAt, profile.profileUpdatedAt));
  const written = db.update(schema.users)
    .set(updates)
    .where(and(eq(schema.users.id, row.id), versionStillNewer))
    .run();

  if (written.changes === 0) {
    for (const file of [avatar, banner]) {
      if (file && !file.startsWith('http') && file !== row.avatar && file !== row.banner) deleteUploadFile(file);
    }
    return db.select().from(schema.users).where(eq(schema.users.id, row.id)).get() ?? row;
  }

  if (row.avatar && !row.avatar.startsWith('http') && row.avatar !== avatar) deleteUploadFile(row.avatar);
  if (row.banner && !row.banner.startsWith('http') && row.banner !== banner) deleteUploadFile(row.banner);

  const updated = db.select().from(schema.users).where(eq(schema.users.id, row.id)).get();
  if (!updated) return row;
  const userUpdatedEvent = { type: 'user_updated' as const, user: sanitizeUser(updated, false) };
  const targetUserIds = collectProfileBroadcastTargetIds(updated.id);
  targetUserIds.add(updated.id); // the row's own sessions (a federated account's other tabs)
  for (const uid of targetUserIds) {
    connectionManager.sendToUser(uid, userUpdatedEvent);
  }
  return updated;
}


export async function processProfileUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  const payload = event.profileUpdate;
  if (!payload) {
    rejected.push({ messageId: event.messageId, reason: 'missing_profile_update_payload' });
    return;
  }

  // Strict attribution: profile updates MUST originate from the home instance.
  // No homeward relay exception — unlike DMs, profile updates always come from home.
  const payloadDomain = extractDomain(payload.homeInstance);
  const sourceDomain = extractDomain(sourceInstance);
  if (payloadDomain !== sourceDomain) {
    console.warn(`[federation] Attribution mismatch in profile_update: homeInstance=${payloadDomain} source=${sourceDomain}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // The row updated is the one that IS the payload's identity, homed on the
  // sending peer (`resolveRelayActor`). A native user of this instance is never
  // one, so its profile is only ever changed here. No such row: accept as a
  // no-op, this instance holds no replica of the user. A row created later
  // asks the home for the current profile then (`scheduleHomeRecordPull`).
  const identity = resolveRelayActor(payload, db);
  if (identity.kind !== 'found' || !identity.user.homeInstance) {
    accepted.push(event.messageId);
    return;
  }
  const localUser = identity.user;

  // Detached accounts are sovereign: the domain now belongs to a different
  // incarnation, which must never overwrite the established account's profile
  // by replaying its old homeUserId. Ack (not reject) — the sender considers
  // this identity theirs to update; from our side the update simply no-ops.
  if (localUser.federationHomeOrphaned === 1) {
    console.log(`[federation] Skipping profile_update for detached account ${localUser.id} (home-orphaned)`);
    accepted.push(event.messageId);
    return;
  }

  await applyHomeProfile(localUser, {
    profileUpdatedAt: payload.profileUpdatedAt ?? null,
    username: payload.username,
    displayName: payload.displayName,
    avatar: payload.avatar,
    banner: payload.banner,
    accentColor: payload.accentColor,
    avatarColor: payload.avatarColor,
    bio: payload.bio,
  }, sourceInstance, db);

  accepted.push(event.messageId);
}


/**
 * One-time / idempotent pass that converts existing absolute-URL avatars and
 * banners on replicated users into local files via downloadProfileAsset.
 *
 * Why: hydrateReplicatedUserProfile historically wrote home-instance URLs into
 * users.avatar / users.banner. When the home instance is offline those URLs
 * 404, leaving sidebars (server activity, friend activity, DM list) showing
 * letter fallbacks. processProfileUpdateEvent only re-downloads on the next
 * profile edit, which most users don't do — so this worker cleans up the
 * accumulated URL rows.
 *
 * Behavior: best-effort. Rows where the home instance can't be reached are
 * left as URLs (they still render while the peer is up), and the worker is
 * safe to re-run on every startup.
 */
export async function backfillReplicatedProfileAssets(): Promise<void> {
  const db = getDb();
  const rows = db
    .select({
      id: schema.users.id,
      homeInstance: schema.users.homeInstance,
      avatar: schema.users.avatar,
      banner: schema.users.banner,
    })
    .from(schema.users)
    .where(
      and(
        sql`${schema.users.homeInstance} IS NOT NULL`,
        eq(schema.users.isDeleted, 0),
        or(
          sql`${schema.users.avatar} LIKE 'http%'`,
          sql`${schema.users.banner} LIKE 'http%'`,
        ),
      ),
    )
    .all();

  if (rows.length === 0) return;

  let avatarOk = 0;
  let bannerOk = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.homeInstance) continue;
    const baseUrl = row.homeInstance.startsWith('http')
      ? row.homeInstance
      : `https://${row.homeInstance}`;

    const updates: Record<string, string | null> = {};

    if (row.avatar && row.avatar.startsWith('http')) {
      const localFile = await downloadProfileAsset(row.avatar, baseUrl);
      if (localFile) {
        updates.avatar = localFile;
        avatarOk++;
      } else {
        skipped++;
      }
    }

    if (row.banner && row.banner.startsWith('http')) {
      const localFile = await downloadProfileAsset(row.banner, baseUrl);
      if (localFile) {
        updates.banner = localFile;
        bannerOk++;
      } else {
        skipped++;
      }
    }

    if (Object.keys(updates).length > 0) {
      db.update(schema.users)
        .set(updates)
        .where(eq(schema.users.id, row.id))
        .run();
    }
  }

  console.log(
    `[federation] Replicated profile asset backfill: ${avatarOk} avatars, ${bannerOk} banners downloaded; ${skipped} unreachable (will retry next start)`,
  );
}
