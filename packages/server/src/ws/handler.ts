import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { getDb, schema } from '../db/index.js';
import { parseClientKind, touchUserActivity } from '../telemetry/activity.js';
import { utcDay } from '../telemetry/day.js';
import { verifyJwt } from '../utils/auth.js';
import { statusOnConnect } from '../utils/presenceStatus.js';
import { collectProfileBroadcastTargetIds } from '../utils/userDeletion.js';
import { handleClientEvent } from './events.js';
import { presenceUpdateFor } from './presenceEvent.js';

import { connectionManager } from './connectionManager.js';
import { buildReadyPayload } from './readyPayload.js';
export { connectionManager } from './connectionManager.js';
export { getVoiceRoomElapsedSeconds, VOICE_RECONNECT_GRACE_MS, type AuthenticatedSocket, type DmRoomMeta, type FederatedCallEntry, type SpaceRoomMeta, type VoiceRoom } from './voiceRoomTypes.js';

// ─── Heartbeat State ──────────────────────────────────────────────────────────
const wsIsAlive: WeakMap<WebSocket, boolean> = new WeakMap();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// The pong path runs every 30 seconds per socket, so a database that keeps
// refusing this write would flood the log at one line per socket per pong. One
// line per hour is the compromise: quiet enough that a persistent fault does
// not bury everything else, loud enough that an outage lasting a week stays
// visible for the whole week. A one-shot flag was the earlier form and it went
// permanently silent after the first failure, so an outage that began before
// anyone looked left no trace at all.
const ACTIVITY_WARN_INTERVAL_MS = 60 * 60 * 1000;
let activityWarnedAt = 0;

/**
 * The last UTC day each live connection recorded activity for.
 *
 * Keyed on the socket, so it dies with the socket and holds nothing across
 * reconnects. `touchUserActivity` already refuses to rewrite a row that holds
 * today, so this memo changes no stored value; what it avoids is the round
 * trip. Without it an `UPDATE` runs for every socket on every pong, which on an
 * instance holding a few hundred desktop clients open is constant write-lock
 * churn on `users` for a column that moves once a day.
 *
 * A miss is always safe: a connection with no memo simply writes, and the
 * statement's own predicate makes that a no-op when the day is already there.
 */
const activityDayByConnection: WeakMap<object, string> = new WeakMap();

/**
 * Day-coarse activity for the opt-in telemetry counts. `authMessage` is the
 * parsed auth message on the auth path (its optional `client` field names the
 * client kind) and null on a heartbeat pong, which touches the day only.
 *
 * A failed write is swallowed: this bookkeeping is optional, and it runs on the
 * auth path (where a throw would look like a rejected token) and inside the
 * 'pong' listener (where an uncaught throw would take the process down).
 *
 * `connection` is the socket, used as the key of a per-connection memo of the
 * day already recorded. Given, a pong that has already recorded today returns
 * without touching the database. Omitted, every call writes.
 */
export function recordConnectionActivity(
  userId: string,
  authMessage: Record<string, unknown> | null,
  now: Date,
  connection?: object,
): void {
  const today = utcDay(now);
  // The auth path is never skipped: it carries the client kind, which can
  // differ from what the row holds even on a day already recorded. Only the
  // pong path, which touches the day and nothing else, has anything to skip.
  if (authMessage === null && connection !== undefined
    && activityDayByConnection.get(connection) === today) {
    return;
  }
  try {
    const db = getDb();
    if (authMessage) {
      touchUserActivity(db, userId, today, parseClientKind(authMessage.client));
    } else {
      touchUserActivity(db, userId, today);
    }
    // Recorded only after the write did not throw, so a failing database is
    // retried on the next pong rather than memoised as done.
    if (connection !== undefined) activityDayByConnection.set(connection, today);
  } catch (err) {
    const at = now.getTime();
    if (activityWarnedAt === 0 || at - activityWarnedAt >= ACTIVITY_WARN_INTERVAL_MS) {
      activityWarnedAt = at;
      console.warn(`[ws] could not record activity: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const ws = socket as unknown as WebSocket;
    let authenticated = false;
    let userId: string | undefined;
    let username: string | undefined;
    let isFederated = false;

    // Set auth timeout - must authenticate within 10 seconds
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
        ws.close();
      }
    }, 10000);

    ws.on('message', (data: Buffer | string) => {
      let parsed: Record<string, unknown>;
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      // Any received message proves liveness
      wsIsAlive.set(ws, true);

      if (!authenticated) {
        // First message must be auth
        if (parsed.type !== 'auth' || typeof parsed.token !== 'string') {
          ws.send(JSON.stringify({ type: 'error', message: 'First message must be auth' }));
          ws.close();
          return;
        }

        try {
          const payload = verifyJwt(parsed.token);
          userId = payload.userId;
          username = payload.username;

          // Reject deleted users and revoked tokens
          const db = getDb();
          const userRow = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
          if (!userRow || userRow.isDeleted) {
            ws.send(JSON.stringify({ type: 'error', message: 'This account has been deleted' }));
            ws.close();
            return;
          }
          // Token revocation: reject tokens issued before last password change
          if (userRow.passwordChangedAt && payload.iat) {
            if (payload.iat < Math.floor(userRow.passwordChangedAt / 1000)) {
              ws.send(JSON.stringify({ type: 'error', message: 'Token has been revoked' }));
              ws.close();
              return;
            }
          }

          authenticated = true;
          isFederated = !!userRow.homeInstance;
          clearTimeout(authTimeout);

          // Publish the user's chosen status as their live presence. For a
          // native row that is chosen_status (idle and dnd survive reconnects
          // and restarts); for a replicated row it is the home instance's last
          // projection. See utils/presenceStatus.ts.
          const connectStatus = statusOnConnect(userRow);
          db.update(schema.users).set({ status: connectStatus }).where(eq(schema.users.id, userId)).run();

          // Add connection
          connectionManager.addConnection(userId, ws);

          // Captured for the pong closure: `userId` is a mutable outer binding, so
          // its narrowing to a string does not survive into the callback.
          const activeUserId = userId;
          recordConnectionActivity(activeUserId, parsed, new Date());

          // Mark alive for heartbeat detection; browsers auto-respond to ping frames (RFC 6455)
          wsIsAlive.set(ws, true);
          ws.on('pong', () => {
            wsIsAlive.set(ws, true);
            // `ws` is the memo key: this socket writes the day once and then
            // stops asking until the day rolls over.
            recordConnectionActivity(activeUserId, null, new Date(), ws);
          });

          // Build and send ready payload
          const readyData = buildReadyPayload(userId);
          ws.send(JSON.stringify({
            type: 'ready',
            ...readyData,
          }));

          // Broadcast the connect status to friends + DM co-members + space co-members.
          const connectPayload = presenceUpdateFor(userId, connectStatus);
          const connectTargets = collectProfileBroadcastTargetIds(userId);
          for (const uid of connectTargets) connectionManager.sendToUser(uid, connectPayload);

          // S2S: project it to all active peers (mirrors profile_update fanout).
          // No-op for a replicated row: its home instance owns the projection.
          // The relay is a full snapshot, so it carries the activities another
          // session of this user already reported (none on a first connection).
          const _uid = userId;
          const connectActivities = connectionManager.getUserActivities(_uid);
          void import('../utils/federationPresence.js').then(({ queuePresenceRelay }) => {
            try { queuePresenceRelay(_uid, connectStatus, connectActivities); } catch (e) { console.warn('[ws] queuePresenceRelay(connect) failed', e); }
          });
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          ws.close();
        }
        return;
      }

      // Fast-path heartbeat — never reaches business logic
      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Rate limit all post-auth, non-ping messages (per-user, shared across tabs)
      if (!connectionManager.getUserRateLimiter(userId!).consume()) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limited' }));
        return;
      }

      // Handle authenticated events
      if (userId && username) {
        try {
          handleClientEvent(parsed, userId, username, ws, isFederated);
        } catch (err) {
          app.log.error({ err, eventType: parsed.type, userId }, 'Unhandled error in WS event handler');
          try {
            ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' }));
          } catch { /* ws may already be closed */ }
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (userId) {
        connectionManager.removeConnection(ws);
      }
    });

    ws.on('error', () => {
      clearTimeout(authTimeout);
    });
  });

  // ─── Heartbeat Sweep ──────────────────────────────────────────────────────
  // Detect dead connections (e.g. PC shut off without TCP FIN).
  // Sends protocol-level ping frames; browsers auto-respond with pong (RFC 6455).
  // Worst-case detection: 30s + 30s + 5s grace = ~65s.
  const HEARTBEAT_INTERVAL_MS = 30_000;

  heartbeatInterval = setInterval(() => {
    for (const [, userConnections] of connectionManager.getAllConnections()) {
      for (const ws of userConnections) {
        if (wsIsAlive.get(ws) === false) {
          ws.terminate(); // Emits 'close' → removeConnection → scheduleDisconnect → finalizeDisconnect
          continue;
        }
        wsIsAlive.set(ws, false);
        if (ws.readyState === 1) ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  app.addHook('onClose', async () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  });
}
