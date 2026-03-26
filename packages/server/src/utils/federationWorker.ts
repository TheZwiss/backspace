import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq, and, lte, asc, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { isFederationRelayEnabled } from './federationOutbox.js';
import { buildFederationHeaders } from './federationAuth.js';
import { generateSnowflake } from './snowflake.js';
import type { FederationRelayRequest, FederationRelayResponse, FederationRelayEvent } from '@backspace/shared';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// ─── Constants ──────────────────────────────────────────────────────────────

const OUTBOX_INTERVAL_MS = 10_000;        // 10 seconds
const FILE_QUEUE_INTERVAL_MS = 30_000;    // 30 seconds
const HEALTH_CHECK_INTERVAL_MS = 3_600_000; // 1 hour

const OUTBOX_BATCH_LIMIT = 50;
const FILE_QUEUE_BATCH_LIMIT = 5;

const OUTBOX_FETCH_TIMEOUT_MS = 30_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;

/** Exponential backoff schedule by attempt number (1-indexed). Values in milliseconds. */
const BACKOFF_SCHEDULE_MS: readonly number[] = [
  30_000,       // attempt 1: 30s
  60_000,       // attempt 2: 1min
  300_000,      // attempt 3: 5min
  900_000,      // attempt 4: 15min
  3_600_000,    // attempt 5: 1hr
  21_600_000,   // attempt 6: 6hr
  86_400_000,   // attempt 7+: 24hr cap
];

const MAX_FILE_ATTEMPTS = 10;
const PEER_UNREACHABLE_THRESHOLD = 10;

// ─── Worker State ───────────────────────────────────────────────────────────

let outboxTimer: ReturnType<typeof setTimeout> | null = null;
let fileQueueTimer: ReturnType<typeof setTimeout> | null = null;
let healthCheckTimer: ReturnType<typeof setTimeout> | null = null;

let outboxAbortController: AbortController | null = null;
let fileQueueAbortController: AbortController | null = null;
let healthCheckAbortController: AbortController | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the backoff delay for a given attempt number (1-indexed).
 * Caps at the last entry in BACKOFF_SCHEDULE_MS.
 */
function getBackoffMs(attempt: number): number {
  const index = Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[Math.max(0, index)] ?? 86_400_000;
}

/**
 * Build the origin URL for this instance.
 * Uses DOMAIN env var for production, falls back to localhost for dev.
 */
function getOurOrigin(): string {
  if (config.domain) {
    return `https://${config.domain}`;
  }
  return `http://localhost:${config.port}`;
}

/**
 * Get the effective max upload size from instance settings or config fallback.
 */
function getMaxUploadSize(): number {
  try {
    const db = getDb();
    const row = db
      .select({ maxUploadSizeBytes: schema.instanceSettings.maxUploadSizeBytes })
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.id, 1))
      .get();
    return row?.maxUploadSizeBytes ?? config.maxUploadSize;
  } catch {
    return config.maxUploadSize;
  }
}

// ─── Outbox Delivery Worker ─────────────────────────────────────────────────

function scheduleOutboxTick(): void {
  outboxTimer = setTimeout(() => {
    processOutboxTick().catch((err) => {
      console.error('[federation-worker] Outbox tick error:', err);
    }).finally(() => {
      scheduleOutboxTick();
    });
  }, OUTBOX_INTERVAL_MS);
}

async function processOutboxTick(): Promise<void> {
  if (!isFederationRelayEnabled()) {
    return;
  }

  const db = getDb();
  const now = Date.now();

  // Fetch outbox entries ready for delivery, joined with active peers
  const entries = db
    .select({
      outboxId: schema.federationOutbox.id,
      peerId: schema.federationOutbox.peerId,
      dmChannelId: schema.federationOutbox.dmChannelId,
      messageId: schema.federationOutbox.messageId,
      eventType: schema.federationOutbox.eventType,
      payload: schema.federationOutbox.payload,
      encryptionVersion: schema.federationOutbox.encryptionVersion,
      attempts: schema.federationOutbox.attempts,
      createdAt: schema.federationOutbox.createdAt,
      peerOrigin: schema.federationPeers.origin,
      peerHmacSecret: schema.federationPeers.hmacSecret,
      peerStatus: schema.federationPeers.status,
    })
    .from(schema.federationOutbox)
    .innerJoin(
      schema.federationPeers,
      eq(schema.federationOutbox.peerId, schema.federationPeers.id),
    )
    .where(
      and(
        lte(schema.federationOutbox.nextRetryAt, now),
        eq(schema.federationPeers.status, 'active'),
      ),
    )
    .orderBy(asc(schema.federationOutbox.createdAt))
    .limit(OUTBOX_BATCH_LIMIT)
    .all();

  if (entries.length === 0) {
    return;
  }

  // Group by peer
  const byPeer = new Map<string, typeof entries>();
  for (const entry of entries) {
    const group = byPeer.get(entry.peerId);
    if (group) {
      group.push(entry);
    } else {
      byPeer.set(entry.peerId, [entry]);
    }
  }

  const ourOrigin = getOurOrigin();

  for (const [peerId, peerEntries] of byPeer) {
    const firstEntry = peerEntries[0];
    if (!firstEntry) continue; // Should never happen given grouping logic above

    const peerOrigin = firstEntry.peerOrigin;
    const peerHmacSecret = firstEntry.peerHmacSecret;

    // Build relay events from outbox entries
    const events: FederationRelayEvent[] = peerEntries.map((entry) => {
      const parsed = JSON.parse(entry.payload) as Partial<FederationRelayEvent>;
      return {
        eventType: entry.eventType as FederationRelayEvent['eventType'],
        dmChannelId: entry.dmChannelId,
        messageId: entry.messageId,
        encryptionVersion: (entry.encryptionVersion ?? 0) as 0,
        timestamp: entry.createdAt,
        ...(parsed.message ? { message: parsed.message } : {}),
        ...(parsed.reactions ? { reactions: parsed.reactions } : {}),
        ...(parsed.reaction ? { reaction: parsed.reaction } : {}),
      };
    });

    const request: FederationRelayRequest = {
      version: 1,
      sourceInstance: ourOrigin,
      events,
    };

    const bodyString = JSON.stringify(request);
    const headers = buildFederationHeaders(bodyString, peerHmacSecret, ourOrigin);

    // Create an abort controller for this specific request
    outboxAbortController = new AbortController();

    try {
      const response = await fetch(`${peerOrigin}/api/federation/relay`, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: AbortSignal.any([
          outboxAbortController.signal,
          AbortSignal.timeout(OUTBOX_FETCH_TIMEOUT_MS),
        ]),
      });

      if (response.ok) {
        const result = await response.json() as FederationRelayResponse;

        // Delete accepted entries
        if (result.accepted.length > 0) {
          // Map accepted messageIds to outbox IDs
          const acceptedSet = new Set(result.accepted);
          const acceptedOutboxIds = peerEntries
            .filter((e) => acceptedSet.has(e.messageId))
            .map((e) => e.outboxId);

          if (acceptedOutboxIds.length > 0) {
            db.delete(schema.federationOutbox)
              .where(inArray(schema.federationOutbox.id, acceptedOutboxIds))
              .run();
          }
        }

        // Log rejected entries (they remain in outbox for retry)
        for (const rejection of result.rejected) {
          console.warn(
            `[federation-worker] Peer ${peerOrigin} rejected message ${rejection.messageId}: ${rejection.reason}`,
          );
        }

        // Update peer health
        db.update(schema.federationPeers)
          .set({
            lastSeenAt: now,
            consecutiveFailures: 0,
          })
          .where(eq(schema.federationPeers.id, peerId))
          .run();
      } else {
        console.warn(
          `[federation-worker] Peer ${peerOrigin} returned HTTP ${response.status}`,
        );
        handleOutboxDeliveryFailure(db, peerId, peerEntries, now);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Worker is stopping — don't update anything
        return;
      }
      console.error(
        `[federation-worker] Failed to deliver to peer ${peerOrigin}:`,
        err instanceof Error ? err.message : err,
      );
      handleOutboxDeliveryFailure(db, peerId, peerEntries, now);
    }
  }
}

function handleOutboxDeliveryFailure(
  db: ReturnType<typeof getDb>,
  peerId: string,
  entries: Array<{ outboxId: string; attempts: number | null }>,
  now: number,
): void {
  // Increment attempts and compute next retry for each entry
  for (const entry of entries) {
    const newAttempts = (entry.attempts ?? 0) + 1;
    const backoffMs = getBackoffMs(newAttempts);

    db.update(schema.federationOutbox)
      .set({
        attempts: newAttempts,
        nextRetryAt: now + backoffMs,
      })
      .where(eq(schema.federationOutbox.id, entry.outboxId))
      .run();
  }

  // Update peer failure tracking
  const peer = db
    .select({ consecutiveFailures: schema.federationPeers.consecutiveFailures })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.id, peerId))
    .get();

  const newFailures = (peer?.consecutiveFailures ?? 0) + 1;
  const updates: Record<string, number | string> = {
    lastFailureAt: now,
    consecutiveFailures: newFailures,
  };

  if (newFailures >= PEER_UNREACHABLE_THRESHOLD) {
    (updates as Record<string, number | string>)['status'] = 'unreachable';
    console.warn(
      `[federation-worker] Peer ${peerId} marked unreachable after ${newFailures} consecutive failures`,
    );
  }

  db.update(schema.federationPeers)
    .set(updates)
    .where(eq(schema.federationPeers.id, peerId))
    .run();
}

// ─── File Queue Download Worker ─────────────────────────────────────────────

function scheduleFileQueueTick(): void {
  fileQueueTimer = setTimeout(() => {
    processFileQueueTick().catch((err) => {
      console.error('[federation-worker] File queue tick error:', err);
    }).finally(() => {
      scheduleFileQueueTick();
    });
  }, FILE_QUEUE_INTERVAL_MS);
}

async function processFileQueueTick(): Promise<void> {
  if (!isFederationRelayEnabled()) {
    return;
  }

  const db = getDb();
  const now = Date.now();

  const pending = db
    .select()
    .from(schema.federationFileQueue)
    .where(
      and(
        eq(schema.federationFileQueue.status, 'pending'),
        lte(schema.federationFileQueue.nextRetryAt, now),
      ),
    )
    .limit(FILE_QUEUE_BATCH_LIMIT)
    .all();

  if (pending.length === 0) {
    return;
  }

  const maxUploadSize = getMaxUploadSize();

  for (const entry of pending) {
    await processFileQueueEntry(db, entry, maxUploadSize, now);
  }
}

async function processFileQueueEntry(
  db: ReturnType<typeof getDb>,
  entry: typeof schema.federationFileQueue.$inferSelect,
  maxUploadSize: number,
  now: number,
): Promise<void> {
  // SSRF protection: validate sourceUrl hostname matches peerOrigin hostname
  try {
    const sourceHostname = new URL(entry.sourceUrl).hostname;
    const peerHostname = new URL(entry.peerOrigin).hostname;
    if (sourceHostname !== peerHostname) {
      console.warn(
        `[federation-worker] SSRF blocked: sourceUrl hostname "${sourceHostname}" does not match peer origin "${peerHostname}" for file queue entry ${entry.id}`,
      );
      db.update(schema.federationFileQueue)
        .set({
          status: 'rejected',
          rejectionReason: 'ssrf_hostname_mismatch',
        })
        .where(eq(schema.federationFileQueue.id, entry.id))
        .run();
      return;
    }
  } catch {
    db.update(schema.federationFileQueue)
      .set({
        status: 'rejected',
        rejectionReason: 'invalid_url',
      })
      .where(eq(schema.federationFileQueue.id, entry.id))
      .run();
    return;
  }

  // Check file size against limit
  if (entry.size > maxUploadSize) {
    db.update(schema.federationFileQueue)
      .set({
        status: 'rejected',
        rejectionReason: 'size_limit_exceeded',
      })
      .where(eq(schema.federationFileQueue.id, entry.id))
      .run();
    return;
  }

  // Create abort controller for this download
  fileQueueAbortController = new AbortController();

  try {
    const response = await fetch(entry.sourceUrl, {
      signal: AbortSignal.any([
        fileQueueAbortController.signal,
        AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
      ]),
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} downloading file from ${entry.sourceUrl}`);
    }

    // Generate a unique local filename using the same pattern as the upload route
    const ext = path.extname(entry.originalName) || '';
    const localId = generateSnowflake();
    const localFilename = `${localId}${ext}`;
    const localPath = path.join(config.uploadDir, localFilename);

    // Ensure upload directory exists
    fs.mkdirSync(config.uploadDir, { recursive: true });

    // Stream the response body to disk
    const nodeStream = Readable.fromWeb(response.body as ReadableStream);
    const writeStream = fs.createWriteStream(localPath);

    try {
      await pipeline(nodeStream, writeStream);
    } catch (pipeErr) {
      // Clean up partial file on failure
      try { fs.unlinkSync(localPath); } catch { /* ignore cleanup errors */ }
      throw pipeErr;
    }

    // Verify file was written and get actual size
    const stat = fs.statSync(localPath);

    // Check actual downloaded size against limit (defense in depth)
    if (stat.size > maxUploadSize) {
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      db.update(schema.federationFileQueue)
        .set({
          status: 'rejected',
          rejectionReason: 'size_limit_exceeded',
        })
        .where(eq(schema.federationFileQueue.id, entry.id))
        .run();
      return;
    }

    // Create a local attachment record
    const attachmentId = generateSnowflake();
    db.insert(schema.attachments)
      .values({
        id: attachmentId,
        dmMessageId: entry.dmMessageId,
        uploaderId: null,
        filename: localFilename,
        originalName: entry.originalName,
        mimetype: entry.mimetype,
        size: stat.size,
        sourceUrl: entry.sourceUrl,
        createdAt: now,
      })
      .run();

    // Mark file queue entry as completed
    db.update(schema.federationFileQueue)
      .set({
        status: 'completed',
        targetFilename: localFilename,
      })
      .where(eq(schema.federationFileQueue.id, entry.id))
      .run();

    console.log(
      `[federation-worker] Downloaded federated file: ${entry.originalName} -> ${localFilename}`,
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Worker is stopping — leave entry as pending for next tick
      return;
    }

    console.error(
      `[federation-worker] Failed to download file ${entry.originalName} from ${entry.peerOrigin}:`,
      err instanceof Error ? err.message : err,
    );

    const newAttempts = (entry.attempts ?? 0) + 1;

    if (newAttempts > MAX_FILE_ATTEMPTS) {
      db.update(schema.federationFileQueue)
        .set({
          status: 'failed',
          attempts: newAttempts,
          rejectionReason: 'max_attempts_exceeded',
        })
        .where(eq(schema.federationFileQueue.id, entry.id))
        .run();
    } else {
      const backoffMs = getBackoffMs(newAttempts);
      db.update(schema.federationFileQueue)
        .set({
          attempts: newAttempts,
          nextRetryAt: now + backoffMs,
        })
        .where(eq(schema.federationFileQueue.id, entry.id))
        .run();
    }
  }
}

// ─── Health Check Worker ────────────────────────────────────────────────────

function scheduleHealthCheckTick(): void {
  healthCheckTimer = setTimeout(() => {
    processHealthCheckTick().catch((err) => {
      console.error('[federation-worker] Health check tick error:', err);
    }).finally(() => {
      scheduleHealthCheckTick();
    });
  }, HEALTH_CHECK_INTERVAL_MS);
}

async function processHealthCheckTick(): Promise<void> {
  const db = getDb();

  const unreachablePeers = db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'unreachable'))
    .all();

  if (unreachablePeers.length === 0) {
    return;
  }

  const now = Date.now();

  for (const peer of unreachablePeers) {
    healthCheckAbortController = new AbortController();

    try {
      const response = await fetch(`${peer.origin}/api/instance/info`, {
        signal: AbortSignal.any([
          healthCheckAbortController.signal,
          AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        ]),
      });

      if (response.ok) {
        db.update(schema.federationPeers)
          .set({
            status: 'active',
            consecutiveFailures: 0,
            lastSeenAt: now,
          })
          .where(eq(schema.federationPeers.id, peer.id))
          .run();

        console.log(
          `[federation-worker] Peer ${peer.origin} recovered — marked active`,
        );
      }
      // If not ok, leave as unreachable — will check again next cycle
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      // Leave as unreachable — will check again next cycle
    }
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Trigger checkpoint sync for peers that have never been synced (lastSyncedAt === 0).
 * This catches historical messages that existed before the relay was enabled.
 */
async function runInitialSyncForNewPeers(): Promise<void> {
  if (!isFederationRelayEnabled()) return;

  const db = getDb();
  const unsyncedPeers = db
    .select()
    .from(schema.federationPeers)
    .where(and(
      eq(schema.federationPeers.status, 'active'),
      eq(schema.federationPeers.lastSyncedAt, 0),
    ))
    .all();

  if (unsyncedPeers.length === 0) return;

  const ourOrigin = config.domain ? `https://${config.domain}` : `http://localhost:${config.port}`;

  for (const peer of unsyncedPeers) {
    try {
      console.log(`[federation-worker] Running initial sync with ${peer.origin}...`);
      let sinceTimestamp = 0;
      let totalEvents = 0;

      // Paginate through all events from the peer
      while (true) {
        const body = JSON.stringify({ sinceTimestamp, limit: 100 });
        const headers = buildFederationHeaders(body, peer.hmacSecret, ourOrigin);

        const response = await fetch(`${peer.origin}/api/federation/sync`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          console.error(`[federation-worker] Sync with ${peer.origin} failed: ${response.status}`);
          break;
        }

        const data = await response.json() as { events: FederationRelayEvent[]; hasMore: boolean; checkpoint: number };

        if (data.events.length === 0) break;

        // Relay the events through our own relay endpoint logic
        // For simplicity, POST them to ourselves
        const relayBody = JSON.stringify({
          version: 1,
          sourceInstance: peer.origin,
          events: data.events,
        });
        const relayHeaders = buildFederationHeaders(relayBody, peer.hmacSecret, peer.origin);

        await fetch(`${ourOrigin}/api/federation/relay`, {
          method: 'POST',
          headers: relayHeaders,
          body: relayBody,
          signal: AbortSignal.timeout(30_000),
        });

        totalEvents += data.events.length;
        sinceTimestamp = data.checkpoint;

        if (!data.hasMore) break;
      }

      // Update lastSyncedAt so this doesn't run again
      db.update(schema.federationPeers)
        .set({ lastSyncedAt: Date.now() })
        .where(eq(schema.federationPeers.id, peer.id))
        .run();

      if (totalEvents > 0) {
        console.log(`[federation-worker] Initial sync with ${peer.origin}: ${totalEvents} events synced`);
      } else {
        console.log(`[federation-worker] Initial sync with ${peer.origin}: no events to sync`);
      }
    } catch (err) {
      console.error(`[federation-worker] Initial sync with ${peer.origin} failed:`, err);
      // Don't update lastSyncedAt — will retry next startup
    }
  }
}

export function startFederationWorkers(): void {
  console.log('[federation-worker] Federation workers started');
  scheduleOutboxTick();
  scheduleFileQueueTick();
  scheduleHealthCheckTick();
  // Run initial sync for newly peered instances (async, non-blocking)
  runInitialSyncForNewPeers().catch((err) => {
    console.error('[federation-worker] Initial sync error:', err);
  });
}

export function stopFederationWorkers(): void {
  if (outboxTimer) {
    clearTimeout(outboxTimer);
    outboxTimer = null;
  }
  if (fileQueueTimer) {
    clearTimeout(fileQueueTimer);
    fileQueueTimer = null;
  }
  if (healthCheckTimer) {
    clearTimeout(healthCheckTimer);
    healthCheckTimer = null;
  }

  outboxAbortController?.abort();
  outboxAbortController = null;

  fileQueueAbortController?.abort();
  fileQueueAbortController = null;

  healthCheckAbortController?.abort();
  healthCheckAbortController = null;

  console.log('[federation-worker] Federation workers stopped');
}
