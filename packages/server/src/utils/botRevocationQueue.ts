import { and, eq, lte } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { extractDomain } from '../routes/federation/identity.js';
import { revokeBotOnOrigin, revokeBotOnPeers, type BotRevokeResult } from './botFederation.js';

/**
 * Revoking a bot on another instance has to survive that instance being away.
 * A revoke that fails for a reason that can pass (unreachable, timeout, not
 * peered at the moment, a 5xx) is kept as one row per (bot, origin) and retried
 * with a growing pause until it lands or `BOT_REVOCATION_MAX_AGE_MS` is over.
 * Success, a refusal that cannot change, and expiry all delete the row, so
 * nothing stays behind (docs/systems/bots.md, "Revocation").
 *
 * The rows reference no user: a deleted bot's tombstone must not take them away.
 */

export const BOT_REVOCATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BASE_DELAY_MS = 5 * 60 * 1000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;

/** What the owner is told per origin: a failure either still pending (retried) or final. */
export type BotRevokeOutcome = { success: true } | { success: false; error: string; pending: boolean };

/** Pause before attempt number `attempts` + 1: 5 min, 10, 20, ... up to 6 h. */
export function revocationDelayMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts), MAX_DELAY_MS);
}

/**
 * Keeps the retryable failures of one revoke round. A pair that is already
 * queued stays queued with its original start time; `full` (the bot is gone)
 * is never downgraded to `soft`.
 */
export function queueBotRevocations(
  botId: string,
  mode: 'soft' | 'full',
  results: Record<string, BotRevokeResult>,
  now: number = Date.now(),
): void {
  const db = getDb();
  for (const [origin, result] of Object.entries(results)) {
    if (result.success || !result.retry) continue;
    const existing = db.select().from(schema.botRevocations)
      .where(and(eq(schema.botRevocations.botId, botId), eq(schema.botRevocations.origin, origin)))
      .get();
    if (existing) {
      db.update(schema.botRevocations)
        .set({ mode: existing.mode === 'full' || mode === 'full' ? 'full' : 'soft', lastError: result.error })
        .where(and(eq(schema.botRevocations.botId, botId), eq(schema.botRevocations.origin, origin)))
        .run();
      continue;
    }
    db.insert(schema.botRevocations).values({
      botId,
      origin,
      mode,
      attempts: 1,
      lastError: result.error,
      createdAt: now,
      nextAttemptAt: now + revocationDelayMs(1),
    }).run();
  }
}

/**
 * The one entry point for revoking a bot abroad: tries every origin now, queues
 * what can still succeed, and reports per origin what the owner should know.
 */
export async function revokeBotWithRetry(
  botId: string,
  origins: string[],
  mode: 'soft' | 'full',
): Promise<Record<string, BotRevokeOutcome>> {
  const results = await revokeBotOnPeers(botId, origins, mode);
  queueBotRevocations(botId, mode, results);
  const outcome: Record<string, BotRevokeOutcome> = {};
  for (const [origin, r] of Object.entries(results)) {
    outcome[origin] = r.success ? { success: true } : { success: false, error: r.error, pending: r.retry };
  }
  return outcome;
}

/**
 * True while a revoke of this bot is still waiting for that host. Until it
 * lands, the host still holds the old federated account, so the home refuses to
 * issue a new credential or proof for it: a re-registration there could not
 * succeed, and the late revoke would otherwise take down the new account.
 */
export function hasPendingBotRevocation(botId: string, hostDomain: string): boolean {
  const wanted = extractDomain(hostDomain).toLowerCase();
  return getDb().select({ origin: schema.botRevocations.origin }).from(schema.botRevocations)
    .where(eq(schema.botRevocations.botId, botId)).all()
    .some(r => extractDomain(r.origin).toLowerCase() === wanted);
}

export interface BotRevocationRunResult { done: number; retried: number; dropped: number }

/** One pass of the background worker over the rows that are due. */
export async function runBotRevocationRetries(now: number = Date.now()): Promise<BotRevocationRunResult> {
  const db = getDb();
  const run: BotRevocationRunResult = { done: 0, retried: 0, dropped: 0 };
  const due = db.select().from(schema.botRevocations)
    .where(lte(schema.botRevocations.nextAttemptAt, now)).all();

  for (const row of due) {
    const key = and(eq(schema.botRevocations.botId, row.botId), eq(schema.botRevocations.origin, row.origin));
    if (now - row.createdAt > BOT_REVOCATION_MAX_AGE_MS) {
      db.delete(schema.botRevocations).where(key).run();
      run.dropped++;
      console.warn(`[bot-revocation] gave up on ${row.origin} for bot ${row.botId} after 7 days (${row.lastError ?? 'no error'})`);
      continue;
    }
    const result = await revokeBotOnOrigin(row.botId, row.origin, row.mode === 'full' ? 'full' : 'soft');
    if (result.success) {
      db.delete(schema.botRevocations).where(key).run();
      run.done++;
    } else if (!result.retry) {
      db.delete(schema.botRevocations).where(key).run();
      run.dropped++;
      console.warn(`[bot-revocation] ${row.origin} refused the revoke of bot ${row.botId}: ${result.error}`);
    } else {
      const attempts = row.attempts + 1;
      db.update(schema.botRevocations)
        .set({ attempts, lastError: result.error, nextAttemptAt: now + revocationDelayMs(attempts) })
        .where(key).run();
      run.retried++;
    }
  }
  return run;
}
