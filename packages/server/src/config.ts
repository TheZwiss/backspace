import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenvConfig({ path: resolve(__dirname, '../../../.env') });

function env(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function envOptional(key: string): string | undefined {
  return process.env[key] || undefined;
}

function envInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got: ${value}`);
  }
  return parsed;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
}

// PUBLIC_ORIGIN overrides the federation transport URL returned by getOurOrigin().
// Used by integration test harnesses that bind to 127.0.0.1:<ephemeral> and by
// reverse-proxy setups where federation must advertise an http:// origin (the
// proxy terminates TLS upstream). When unset, getOurOrigin() falls back to
// https://${DOMAIN} for production safety.
const publicOrigin = envOptional('PUBLIC_ORIGIN');
if (publicOrigin !== undefined) {
  if (!/^https?:\/\//i.test(publicOrigin)) {
    throw new Error(
      `PUBLIC_ORIGIN must start with http:// or https:// — got: ${publicOrigin}`
    );
  }
}

// AGPL-3.0 § 13 "network-use source offer": users interacting over the network
// must be able to obtain the Corresponding Source of the *running* version.
// Operators who modify Backspace and self-host MUST point this at their own
// fork's source so the offer stays accurate. Defaults to the upstream repo for
// unmodified deployments.
const UPSTREAM_SOURCE_URL = 'https://github.com/TheZwiss/backspace';
const sourceCodeUrl = envOptional('BACKSPACE_SOURCE_URL') ?? UPSTREAM_SOURCE_URL;
if (!/^https?:\/\//i.test(sourceCodeUrl)) {
  throw new Error(
    `BACKSPACE_SOURCE_URL must start with http:// or https:// — got: ${sourceCodeUrl}`
  );
}

// Short git SHA/tag of the running build, injected at Docker build time via the
// BACKSPACE_COMMIT build arg (see Dockerfile / deploy.sh). Null in local dev
// (no build step) — the § 13 offer still works via version + sourceCodeUrl.
const commit = envOptional('BACKSPACE_COMMIT') ?? null;

export const config = {
  port: envInt('PORT', 3000),
  host: env('HOST', '0.0.0.0'),
  jwtSecret: env('JWT_SECRET'),
  jwtExpiresIn: env('JWT_EXPIRES_IN', '30d'),
  domain: envOptional('DOMAIN'),
  publicOrigin,
  sourceCodeUrl,
  commit,

  livekit: {
    url: envOptional('LIVEKIT_URL'),
    apiKey: envOptional('LIVEKIT_API_KEY'),
    apiSecret: envOptional('LIVEKIT_API_SECRET'),
  },

  uploadDir: env('UPLOAD_DIR', resolve(__dirname, '../../../data/uploads')),
  tusUploadDir: resolve(env('UPLOAD_DIR', resolve(__dirname, '../../../data/uploads')), '.tus'),
  tusExpirationMs: envInt('TUS_EXPIRATION_HOURS', 24) * 60 * 60 * 1000,
  tusStragglerSweepMs: envInt('TUS_STRAGGLER_SWEEP_HOURS', 48) * 60 * 60 * 1000,
  dbPath: env('DB_PATH', resolve(__dirname, '../../../data/backspace.db')),
  maxUploadSize: envInt('MAX_UPLOAD_SIZE', 104857600),
  registrationOpen: envBool('REGISTRATION_OPEN', true),
  backup: {
    dir: envOptional('BACKUP_DIR') ?? resolve(dirname(env('DB_PATH', resolve(__dirname, '../../../data/backspace.db'))), 'backups'),
    intervalHours: envInt('BACKUP_INTERVAL_HOURS', 24),
    keepScheduled: envInt('BACKUP_KEEP_SCHEDULED', 7),
    keepPreMigration: envInt('BACKUP_KEEP_PREMIGRATION', 5),
    keepManual: envInt('BACKUP_KEEP_MANUAL', 10),
    offsiteCmd: envOptional('BACKUP_OFFSITE_CMD'),
    disabled: envBool('BACKUP_DISABLED', false),
  },
} as const;

if (config.jwtSecret.length < 32) {
  throw new Error(
    `JWT_SECRET must be at least 32 characters (got ${config.jwtSecret.length}). ` +
    `Generate one with: openssl rand -hex 32`
  );
}
