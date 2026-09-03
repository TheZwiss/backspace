import { config as dotenvConfig } from 'dotenv';
import { readFileSync } from 'fs';
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

// The running version, read from this package's own manifest rather than kept
// as a second copy in the source. A hand-maintained constant is what let the
// reported version sit at 1.0.0 through two releases: it duplicated
// package.json and nothing made the two agree. Reading it means they cannot
// disagree. scripts/bump-version.mjs writes every manifest at once and
// test/version-consistency.test.ts fails if they drift apart.
//
// packages/server/package.json is present in the runtime image (Dockerfile
// copies it at the `runtime` stage), so this resolves in production as well as
// in development. Failing loudly is deliberate: the version is half of the
// AGPL-3.0 section 13 source offer, and an instance that cannot say which
// version it is running cannot make that offer accurately.
function readPackageVersion(): string {
  const manifestPath = resolve(__dirname, '../package.json');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read ${manifestPath} to determine the running version: ${(err as Error).message}`
    );
  }

  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof (parsed as { version?: unknown }).version !== 'string' ||
    (parsed as { version: string }).version === ''
  ) {
    throw new Error(`${manifestPath} has no usable "version" field.`);
  }

  return (parsed as { version: string }).version;
}

const version = readPackageVersion();

export const config = {
  port: envInt('PORT', 3000),
  host: env('HOST', '0.0.0.0'),
  jwtSecret: env('JWT_SECRET'),
  jwtExpiresIn: env('JWT_EXPIRES_IN', '30d'),
  domain: envOptional('DOMAIN'),
  publicOrigin,
  version,
  sourceCodeUrl,
  commit,

  livekit: {
    url: envOptional('LIVEKIT_URL'),
    apiKey: envOptional('LIVEKIT_API_KEY'),
    apiSecret: envOptional('LIVEKIT_API_SECRET'),
  },

  federation: {
    /**
     * Allow an origin that a stranger asserted to resolve to a private address.
     *
     * Off by default. While it is off, an origin supplied by someone with no
     * established peering relationship must be publicly routable before this
     * instance will send a request to it. Origins an admin approved are
     * unaffected either way, so peering with a private peer keeps working
     * through the admin routes.
     *
     * Turn it on for a LAN-only deployment where every instance sits on a
     * private address and users add each other by handle. The two-instance
     * test harness sets it for the same reason.
     */
    allowPrivatePeers: envBool('FEDERATION_ALLOW_PRIVATE_PEERS', false),
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
