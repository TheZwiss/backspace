/**
 * TOTP 2FA endpoints (issue #182). Wraps the totp.ts utility with route-level
 * concerns: federation safety, password re-confirmation, audit logging.
 *
 * Federation model:
 *   - Federated users (homeInstance set, federationHomeOrphaned = 0) manage
 *     2FA on their HOME instance. ALL setup/disable/regenerate/status calls
 *     from a federated session are rejected with 403 "Federated accounts must
 *     manage 2FA on their home instance". This avoids two sources of truth.
 *   - Detached accounts (federationHomeOrphaned = 1) are sovereign LOCAL
 *     accounts after their home instance was reset/lost — they may enable
 *     2FA like any native user.
 *   - Replicated stubs (passwordHash === '!federation-replicated') can never
 *     log in to begin with; we reject them explicitly anyway for safety.
 *
 * Endpoint surface:
 *   POST /api/auth/totp/setup/initiate           — begin enrollment (auth)
 *   POST /api/auth/totp/setup/confirm            — verify first code, finalize (auth)
 *   POST /api/auth/totp/disable                  — require password + code (auth)
 *   POST /api/auth/totp/recovery-codes/regenerate — require password + code (auth)
 *   GET  /api/auth/totp/status                   — read enrollment state (auth)
 *
 * The login flow lives in routes/auth.ts — see that file for the 2FA step.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate, verifyPassword } from '../utils/auth.js';
import {
  generateTotpSecret,
  buildOtpAuthUrl,
  verifyTotp,
  encryptTotpSecret,
  decryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../utils/totp.js';
import { generateSnowflake } from '../utils/snowflake.js';

// 12-char hex (24 bits) instance token. Embedded in the otpauth label so
// users can disambiguate enrollments across multiple instances.
const ISSUER = process.env['BACKSPACE_ISSUER'] || 'Backspace';

interface InitiateResponse {
  /** Base32-encoded TOTP secret. Displayed once during setup; never returned again. */
  secret: string;
  /** otpauth:// URI the authenticator app consumes. */
  otpauthUrl: string;
}

interface ConfirmResponse {
  /** Recovery codes (single-use). Displayed once; never returned again. */
  recoveryCodes: string[];
}

interface StatusResponse {
  /** TOTP fully verified and active. */
  enabled: boolean;
  /** Setup initiated but confirm() not yet completed. */
  hasPendingSetup: boolean;
  /** User has at least one unused recovery code. */
  hasRecoveryCodes: boolean;
}

/**
 * Federation guard. Returns true if the user may use 2FA on THIS instance.
 * Native users (homeInstance IS NULL): always allowed.
 * Detached accounts (federationHomeOrphaned = 1): allowed (sovereign local).
 * Federated accounts (homeInstance set, not detached): rejected — must use home.
 * Replicated stubs (passwordHash === '!federation-replicated'): rejected.
 */
async function assert2faLocalAccount(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
): Promise<{ id: string; passwordHash: string; homeInstance: string | null; username: string } | null> {
  const db = getDb();
  const user = db.select({
    id: schema.users.id,
    passwordHash: schema.users.passwordHash,
    homeInstance: schema.users.homeInstance,
    username: schema.users.username,
    federationHomeOrphaned: schema.users.federationHomeOrphaned,
  }).from(schema.users).where(eq(schema.users.id, request.userId)).get();

  if (!user) {
    reply.code(404).send({ error: 'User not found', statusCode: 404 });
    return null;
  }

  // Replicated stubs cannot log in to begin with; the assertion is defensive.
  if (user.passwordHash === '!federation-replicated') {
    reply.code(403).send({ error: 'Federation replicas cannot enable 2FA', statusCode: 403 });
    return null;
  }

  // Federated, non-detached: 2FA is the home instance's responsibility.
  if (user.homeInstance !== null && user.federationHomeOrphaned !== 1) {
    reply.code(403).send({
      error: 'Federated accounts must manage 2FA on their home instance',
      statusCode: 403,
    });
    return null;
  }

  return {
    id: user.id,
    passwordHash: user.passwordHash,
    homeInstance: user.homeInstance,
    username: user.username,
  };
}

/** Re-verify the user's password. Used as a confirmatory step before destructive 2FA actions. */
async function reauthenticatePassword(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
  userId: string,
  password: unknown,
): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0) {
    reply.code(400).send({ error: 'Password is required to confirm this action', statusCode: 400 });
    return false;
  }
  const db = getDb();
  const user = db.select({ passwordHash: schema.users.passwordHash })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) {
    reply.code(404).send({ error: 'User not found', statusCode: 404 });
    return false;
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    reply.code(403).send({ error: 'Incorrect password', statusCode: 403 });
    return false;
  }
  return true;
}

/**
 * Verify a code (TOTP or recovery) against the user's enrollment.
 * Returns true on success. Caller persists lastUsedCounter / usedAt.
 */
async function verifyCodeForUser(
  userId: string,
  code: string,
): Promise<{ valid: boolean; newLastUsedCounter?: string }> {
  const db = getDb();
  const totpRow = db.select().from(schema.userTotp).where(eq(schema.userTotp.userId, userId)).get();
  if (!totpRow || totpRow.verifiedAt === null) {
    return { valid: false };
  }

  // Try as recovery code first — short strings that aren't pure digits fall
  // through to TOTP verify and get rejected there.
  const recoveryRows = db.select({ id: schema.userRecoveryCodes.id, codeHash: schema.userRecoveryCodes.codeHash, usedAt: schema.userRecoveryCodes.usedAt })
    .from(schema.userRecoveryCodes)
    .where(and(eq(schema.userRecoveryCodes.userId, userId), isNull(schema.userRecoveryCodes.usedAt)))
    .all();
  for (const row of recoveryRows) {
    if (await verifyRecoveryCode(code, row.codeHash)) {
      // Burn the recovery code — single-use. The row stays for audit;
      // subsequent attempts against the same row will fail because usedAt is set.
      const now = Date.now();
      db.update(schema.userRecoveryCodes)
        .set({ usedAt: now })
        .where(eq(schema.userRecoveryCodes.id, row.id))
        .run();
      return { valid: true };
    }
  }

  // TOTP path.
  const secret = decryptTotpSecret(totpRow.secret);
  const result = verifyTotp(secret, code, totpRow.period, totpRow.digits, {
    lastUsedCounter: Number(totpRow.lastUsedCounter),
  });
  if (!result.valid || result.counter === null) {
    return { valid: false };
  }
  return { valid: true, newLastUsedCounter: result.counter.toString() };
}

export async function totpRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /api/auth/totp/setup/initiate ─────────────────────────────────────
  // Begins enrollment. Generates a fresh 160-bit secret, encrypts it at rest,
  // and returns { secret, otpauthUrl } for the client to render a QR code.
  // The row is created with verifiedAt = NULL — it is NOT yet active.
  // Re-calling initiate() before confirm() simply overwrites the pending row.
  app.post<{ Body: Record<string, never> }>('/api/auth/totp/setup/initiate', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const guard = await assert2faLocalAccount(app, request, reply);
    if (!guard) return;

    const db = getDb();
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    const now = Date.now();
    const issuer = `${ISSUER}`;
    const accountName = guard.username;
    const otpauthUrl = buildOtpAuthUrl({ secret, issuer, accountName });

    // Upsert: replace any pending or active enrollment with this fresh secret.
    // If the user already has a verified enrollment, refuse — they must disable
    // first. This prevents an attacker with a stolen session from silently
    // re-enrolling and capturing the new secret.
    const existing = db.select().from(schema.userTotp).where(eq(schema.userTotp.userId, guard.id)).get();
    if (existing && existing.verifiedAt !== null) {
      return reply.code(409).send({
        error: 'Two-factor authentication is already enabled. Disable it first to re-enroll.',
        statusCode: 409,
      });
    }

    if (existing) {
      db.update(schema.userTotp)
        .set({ secret: encrypted, verifiedAt: null, lastUsedCounter: '0', updatedAt: now })
        .where(eq(schema.userTotp.userId, guard.id))
        .run();
    } else {
      db.insert(schema.userTotp).values({
        userId: guard.id,
        secret: encrypted,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        verifiedAt: null,
        lastUsedCounter: '0',
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    app.log.info(`[totp] setup initiated user=${guard.id}`);
    const response: InitiateResponse = { secret, otpauthUrl };
    return reply.code(200).send(response);
  });

  // ─── POST /api/auth/totp/setup/confirm ──────────────────────────────────────
  // Verify the first TOTP code. On success, mark verifiedAt, generate recovery
  // codes (bcrypt-hashed, single-use), and return the plaintext codes for the
  // client to display ONCE.
  app.post<{ Body: { code?: unknown } }>('/api/auth/totp/setup/confirm', {
    preHandler: authenticate,
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const guard = await assert2faLocalAccount(app, request, reply);
    if (!guard) return;

    const code = request.body?.code;
    if (typeof code !== 'string' || !/^[A-Z0-9]{6,12}$/i.test(code)) {
      return reply.code(400).send({ error: 'A 6-digit TOTP code or 12-character recovery code is required', statusCode: 400 });
    }

    const db = getDb();
    const pending = db.select().from(schema.userTotp).where(eq(schema.userTotp.userId, guard.id)).get();
    if (!pending) {
      return reply.code(400).send({ error: 'No pending 2FA setup found. Call /setup/initiate first.', statusCode: 400 });
    }
    if (pending.verifiedAt !== null) {
      return reply.code(409).send({ error: 'Two-factor authentication is already enabled.', statusCode: 409 });
    }

    // Decrypt the pending secret and verify the presented code against it.
    // We do NOT consult lastUsedCounter here — the enrollment isn't yet active,
    // so a previously-tested code is fine.
    const secret = decryptTotpSecret(pending.secret);
    const result = verifyTotp(secret, code, pending.period, pending.digits, {});
    if (!result.valid) {
      return reply.code(400).send({ error: 'Invalid code. Scan the QR again and try once more.', statusCode: 400 });
    }

    const now = Date.now();
    db.transaction((tx) => {
      tx.update(schema.userTotp)
        .set({ verifiedAt: now, updatedAt: now })
        .where(eq(schema.userTotp.userId, guard.id))
        .run();

      // Wipe any prior recovery codes — fresh enrollment means fresh codes.
      tx.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, guard.id)).run();
    });

    const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
    for (const c of codes) {
      const id = generateSnowflake();
      const codeHash = await hashRecoveryCode(c);
      db.insert(schema.userRecoveryCodes).values({
        id,
        userId: guard.id,
        codeHash,
        usedAt: null,
        createdAt: now,
      }).run();
    }

    app.log.info(`[totp] setup confirmed user=${guard.id} recovery=${RECOVERY_CODE_COUNT}`);
    const response: ConfirmResponse = { recoveryCodes: codes };
    return reply.code(200).send(response);
  });

  // ─── POST /api/auth/totp/disable ────────────────────────────────────────────
  // Requires password + current TOTP code (or recovery code). Deletes both
  // user_totp and user_recovery_codes.
  app.post<{ Body: { password?: unknown; code?: unknown } }>('/api/auth/totp/disable', {
    preHandler: authenticate,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const guard = await assert2faLocalAccount(app, request, reply);
    if (!guard) return;

    const passwordOk = await reauthenticatePassword(app, request, reply, guard.id, request.body?.password);
    if (!passwordOk) return;

    const code = request.body?.code;
    if (typeof code !== 'string' || !/^[A-Z0-9]{6,12}$/i.test(code)) {
      return reply.code(400).send({ error: 'A 6-digit TOTP code or 12-character recovery code is required', statusCode: 400 });
    }

    const result = await verifyCodeForUser(guard.id, code);
    if (!result.valid) {
      return reply.code(403).send({ error: 'Invalid code', statusCode: 403 });
    }

    const db = getDb();
    db.transaction((tx) => {
      tx.delete(schema.userTotp).where(eq(schema.userTotp.userId, guard.id)).run();
      tx.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, guard.id)).run();
    });

    app.log.info(`[totp] disabled user=${guard.id}`);
    return reply.code(200).send({ success: true });
  });

  // ─── POST /api/auth/totp/recovery-codes/regenerate ─────────────────────────
  // Rotate the recovery codes. Requires password + TOTP code (NOT a recovery
  // code — that would let a single leaked recovery code drain all others).
  app.post<{ Body: { password?: unknown; code?: unknown } }>('/api/auth/totp/recovery-codes/regenerate', {
    preHandler: authenticate,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const guard = await assert2faLocalAccount(app, request, reply);
    if (!guard) return;

    const passwordOk = await reauthenticatePassword(app, request, reply, guard.id, request.body?.password);
    if (!passwordOk) return;

    const code = request.body?.code;
    if (typeof code !== 'string' || !/^[A-Z0-9]{6,12}$/i.test(code)) {
      return reply.code(400).send({ error: 'A 6-digit TOTP code is required to regenerate recovery codes', statusCode: 400 });
    }

    const db = getDb();
    const totpRow = db.select().from(schema.userTotp).where(eq(schema.userTotp.userId, guard.id)).get();
    if (!totpRow || totpRow.verifiedAt === null) {
      return reply.code(400).send({ error: 'Two-factor authentication is not enabled', statusCode: 400 });
    }

    // Recovery-codes regeneration MUST be gated by a fresh TOTP code, NOT a
    // recovery code — otherwise a single leaked recovery code could rotate
    // the rest. Enforce by trying TOTP first; if it fails, reject.
    const secret = decryptTotpSecret(totpRow.secret);
    const totpResult = verifyTotp(secret, code, totpRow.period, totpRow.digits, {
      lastUsedCounter: Number(totpRow.lastUsedCounter),
    });
    if (!totpResult.valid || totpResult.counter === null) {
      return reply.code(403).send({ error: 'Invalid code. Recovery codes cannot be regenerated using a recovery code.', statusCode: 403 });
    }

    const now = Date.now();
    db.transaction((tx) => {
      tx.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, guard.id)).run();
      tx.update(schema.userTotp)
        .set({ lastUsedCounter: totpResult.counter!.toString(), updatedAt: now })
        .where(eq(schema.userTotp.userId, guard.id))
        .run();
    });

    const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
    for (const c of codes) {
      const id = generateSnowflake();
      const codeHash = await hashRecoveryCode(c);
      db.insert(schema.userRecoveryCodes).values({
        id,
        userId: guard.id,
        codeHash,
        usedAt: null,
        createdAt: now,
      }).run();
    }

    app.log.info(`[totp] recovery codes regenerated user=${guard.id}`);
    const response: ConfirmResponse = { recoveryCodes: codes };
    return reply.code(200).send(response);
  });

  // ─── GET /api/auth/totp/status ─────────────────────────────────────────────
  // Read-only state for the Settings UI.
  app.get('/api/auth/totp/status', { preHandler: authenticate }, async (request, reply) => {
    const guard = await assert2faLocalAccount(app, request, reply);
    if (!guard) return;

    const db = getDb();
    const totpRow = db.select().from(schema.userTotp).where(eq(schema.userTotp.userId, guard.id)).get();
    const unusedRecoveryCount = db.select({ id: schema.userRecoveryCodes.id })
      .from(schema.userRecoveryCodes)
      .where(and(eq(schema.userRecoveryCodes.userId, guard.id), isNull(schema.userRecoveryCodes.usedAt)))
      .all().length;

    const response: StatusResponse = {
      enabled: totpRow?.verifiedAt !== null && totpRow !== undefined,
      hasPendingSetup: totpRow !== undefined && totpRow.verifiedAt === null,
      hasRecoveryCodes: unusedRecoveryCount > 0,
    };
    return reply.code(200).send(response);
  });
}
