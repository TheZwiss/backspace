import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { getDb, schema } from '../../db/index.js';
import { deleteUploadFile } from '../../utils/fileCleanup.js';
import { sanitizeUser } from '../../utils/sanitize.js';
import { generateSnowflake } from '../../utils/snowflake.js';
import { collectProfileBroadcastTargetIds } from '../../utils/userDeletion.js';
import { connectionManager } from '../../ws/handler.js';
import { and, eq, or, sql } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FederationRelayEvent, FederationRelayProfileSnapshot } from '@backspace/shared';
import { extractDomain } from './identity.js';

/**
 * Hydrate a replicated user stub with profile data from a relay event.
 * Only updates fields that are currently null/empty on the local row,
 * so manually-set local values are preserved.
 */
export async function hydrateReplicatedUserProfile(
  user: typeof schema.users.$inferSelect,
  profile: FederationRelayProfileSnapshot | undefined,
  db: ReturnType<typeof getDb>,
): Promise<typeof schema.users.$inferSelect> {
  if (!profile) return user;
  if (!user.homeInstance) return user; // Don't update native users
  // Detached accounts are sovereign local accounts: the home domain now belongs
  // to a different incarnation, so a relayed snapshot resolved via an old
  // homeUserId (tier-1 historical hit) must never fill this row's fields. No-op
  // return, mirroring the profile_update / presence_update / identity-delete
  // guards (detach spec §4.3).
  if (user.federationHomeOrphaned === 1) return user;

  const baseUrl = user.homeInstance.startsWith('http') ? user.homeInstance : `https://${user.homeInstance}`;
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

  const updates: Record<string, string | null> = {};
  // Use displayName from profile, falling back to the home username (without
  // the @domain suffix that the local replicated username carries).  This
  // ensures federated users show a human-readable name instead of the raw
  // "user@instance.example" federation username.
  const effectiveDisplayName = profile.displayName || profile.username || null;
  if (effectiveDisplayName && !user.displayName) updates.displayName = effectiveDisplayName;
  // Hydrate is best-effort: only fill empty fields. Never overwrite existing
  // avatar/banner values — that is exclusively processProfileUpdateEvent's job
  // (which carries a monotonic version). In particular, locally-downloaded
  // bare filenames produced by that path must not be clobbered back to URLs.
  if (profile.avatar && !user.avatar) updates.avatar = await resolveAsset(profile.avatar);
  if (profile.avatarColor) updates.avatarColor = profile.avatarColor;
  if (profile.banner && !user.banner) updates.banner = await resolveAsset(profile.banner);
  if (profile.bio && !user.bio) updates.bio = profile.bio;

  if (Object.keys(updates).length === 0) return user;

  db.update(schema.users)
    .set(updates)
    .where(eq(schema.users.id, user.id))
    .run();

  return { ...user, ...updates };
}


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
    const response = await fetch(url, {
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

    // Ensure upload directory exists
    fs.mkdirSync(config.uploadDir, { recursive: true });

    // Stream to temp file
    const nodeStream = Readable.fromWeb(response.body as ReadableStream);
    const writeStream = fs.createWriteStream(tempPath);
    await pipeline(nodeStream, writeStream);

    // Atomic rename
    fs.renameSync(tempPath, finalPath);

    return finalFilename;
  } catch (err) {
    // Clean up temp file on any failure
    try { fs.unlinkSync(tempPath); } catch { /* may not exist */ }
    console.warn(`[federation] Profile asset download failed for ${url}:`, (err as Error).message);
    return null;
  }
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

  // Look up the local replicated user by canonical identity
  const localUser = db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.homeUserId, payload.homeUserId),
        eq(schema.users.isDeleted, 0),
      ),
    )
    .get();

  if (!localUser) {
    // This peer has no replica of this user — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Verify the homeInstance domain matches (guard against homeUserId collisions)
  if (localUser.homeInstance && extractDomain(localUser.homeInstance) !== payloadDomain) {
    accepted.push(event.messageId);
    return;
  }

  // Detached accounts are sovereign: the domain now belongs to a different
  // incarnation, which must never overwrite the established account's profile
  // by replaying its old homeUserId. Ack (not reject) — the sender considers
  // this identity theirs to update; from our side the update simply no-ops.
  if (localUser.federationHomeOrphaned === 1) {
    console.log(`[federation] Skipping profile_update for detached account ${localUser.id} (home-orphaned)`);
    accepted.push(event.messageId);
    return;
  }

  // Version check: reject stale/duplicate events
  const storedTs = localUser.profileUpdatedAt ?? 0;
  const incomingTs = payload.profileUpdatedAt ?? 0;
  if (incomingTs <= storedTs) {
    accepted.push(event.messageId);
    return;
  }

  // ── Resolve avatar/banner: download locally, fall back to absolute URL ──
  let resolvedAvatar: string | null = payload.avatar ?? null;
  let resolvedBanner: string | null = payload.banner ?? null;

  // Download avatar
  if (resolvedAvatar && resolvedAvatar.startsWith('http')) {
    const localFile = await downloadProfileAsset(resolvedAvatar, sourceInstance);
    resolvedAvatar = localFile ?? resolvedAvatar; // local filename or absolute URL fallback
  } else if (resolvedAvatar && !resolvedAvatar.startsWith('http')) {
    // Bare filename (shouldn't happen) — resolve to absolute URL
    const baseUrl = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    const absoluteUrl = `${baseUrl}/api/uploads/${resolvedAvatar}`;
    const localFile = await downloadProfileAsset(absoluteUrl, sourceInstance);
    resolvedAvatar = localFile ?? absoluteUrl;
  }

  // Download banner
  if (resolvedBanner && resolvedBanner.startsWith('http')) {
    const localFile = await downloadProfileAsset(resolvedBanner, sourceInstance);
    resolvedBanner = localFile ?? resolvedBanner;
  } else if (resolvedBanner && !resolvedBanner.startsWith('http')) {
    const baseUrl = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    const absoluteUrl = `${baseUrl}/api/uploads/${resolvedBanner}`;
    const localFile = await downloadProfileAsset(absoluteUrl, sourceInstance);
    resolvedBanner = localFile ?? absoluteUrl;
  }

  // Clean up old local files being replaced
  const oldAvatar = localUser.avatar;
  const oldBanner = localUser.banner;
  if (oldAvatar && !oldAvatar.startsWith('http') && oldAvatar !== resolvedAvatar) {
    deleteUploadFile(oldAvatar);
  }
  if (oldBanner && !oldBanner.startsWith('http') && oldBanner !== resolvedBanner) {
    deleteUploadFile(oldBanner);
  }

  // Authoritative overwrite — home instance is always right.
  // displayName falls back to the home user's canonical username when null,
  // mirroring hydrateReplicatedUserProfile so stubs whose home user has no
  // displayName show the real handle instead of getting clobbered to null.
  // (The username field on the wire is the home's canonical handle, not the
  // stub's local-part; usernames are immutable on the home instance, so we
  // never rewrite the stub's username column here.)
  const effectiveDisplayName = payload.displayName ?? payload.username ?? null;
  db.update(schema.users)
    .set({
      displayName: effectiveDisplayName,
      avatar: resolvedAvatar,
      banner: resolvedBanner,
      accentColor: payload.accentColor,
      avatarColor: payload.avatarColor,
      bio: payload.bio,
      profileUpdatedAt: payload.profileUpdatedAt,
    })
    .where(eq(schema.users.id, localUser.id))
    .run();

  // Broadcast user_updated to local clients
  const updatedUser = db.select().from(schema.users).where(eq(schema.users.id, localUser.id)).get();
  if (updatedUser) {
    const sanitized = sanitizeUser(updatedUser, false);
    const targetUserIds = collectProfileBroadcastTargetIds(localUser.id);
    targetUserIds.add(localUser.id); // Include self (other tabs/connections)
    const userUpdatedEvent = { type: 'user_updated' as const, user: sanitized };
    for (const uid of targetUserIds) {
      connectionManager.sendToUser(uid, userUpdatedEvent);
    }
  }

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
