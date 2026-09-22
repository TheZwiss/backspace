import { config as dotenvConfig } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The test suite never reads the checkout's `.env`. CI has none, so a value a
// developer keeps there (DOMAIN, REGISTRATION_OPEN, PORT) would make the same
// suite pass in CI and fail locally: the self-homed identity guard, for one,
// reads `config.domain` before the origin the federation tests mock. Vitest's
// setup file (`test/setup-env.ts`) sets NODE_ENV and the keys the suite needs,
// and the two-instance harness passes a child instance its whole environment
// explicitly, so under test everything comes from the process environment.
if (process.env.NODE_ENV !== 'test') {
  dotenvConfig({ path: resolve(__dirname, '../../../.env') });
}

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

/**
 * A count, read strictly: the value must be a non-negative integer and nothing
 * else. Unlike `envInt` this refuses `parseInt`'s leftovers ('2 hops', '1.5',
 * '') instead of silently taking the digits it recognises, and it never falls
 * back to the default once the variable is set. A security-shaped number that
 * quietly becomes the default when it is mistyped is the failure this guards
 * against: the operator would be told nothing and would run a setting they did
 * not choose.
 */
function envCount(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Environment variable ${key} must be a non-negative integer (0, 1, 2, ...), got: ${JSON.stringify(value)}`
    );
  }
  return Number(trimmed);
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

/**
 * The most hops any real deployment has. A CDN, in front of the operator's own
 * reverse proxy, in front of a tunnel daemon is three, so four is already one
 * more than the deepest topology this project has been asked about.
 *
 * The cap exists because the failure above it is silent. `TRUSTED_PROXY_HOPS=11`
 * as a slip of the finger for 1 trusts eleven hops, which on a one-proxy
 * instance means the whole forwarded chain, which is the `trustProxy: true`
 * behaviour this setting exists to remove. Nothing would look wrong: the
 * operator configured the thing, and the instance boots. A number that cannot
 * describe a real deployment is a typo, and it is refused the same way
 * '2 hops' is.
 */
const MAX_TRUSTED_PROXY_HOPS = 4;

/**
 * How many proxies in front of this app are trusted to have written
 * `X-Forwarded-For`, counted from the app outwards. It becomes Fastify's
 * `trustProxy` (see `index.ts`), and through it the source of `request.ip`.
 *
 * At 1, `request.ip` is the entry the nearest proxy appended, which is the
 * address that proxy actually saw. Anything a client writes into the header
 * sits further left and is ignored. `true`, which this was until it became a
 * count, trusts the whole chain and takes the left-most entry: whatever the
 * client cared to send.
 *
 * That matters because this address is what every rate limit in the app keys
 * on, the global one and the per-route ones (`docs/systems/api.md`, "Rate
 * limiting") and the hand-written limiter on `POST /federation/peer/accept`,
 * which is unauthenticated first contact. It is also what the request log
 * records as `remoteAddress`.
 *
 * **What an operator sets it to.** The number of proxies they actually run
 * in front of the app:
 *
 * - `1` (the default) for the bundled Caddy, an operator's own reverse
 *   proxy, or a tunnel daemon. Every deployment mode this repo ships is one
 *   hop.
 * - `2` for a CDN in front of their own proxy. Left at 1, the app sees the
 *   CDN's address and everyone behind it lands in one rate-limit bucket.
 * - `0` for nothing in front at all. That case is not cosmetic: at 1 a lone
 *   `X-Forwarded-For` entry cannot be told apart from a proxy's word, so a
 *   directly exposed instance left at 1 believes whatever a client sends. At
 *   0 the header is ignored and the socket address is used.
 *
 * Too low is a degradation (everyone behind the nearest proxy shares a
 * bucket); too high is a hole (the key goes back to the client). When in
 * doubt, too low.
 *
 * Both ways of getting it wrong refuse to boot rather than resolving to
 * something the operator did not choose: a value that is not a non-negative
 * integer, and a value above `MAX_TRUSTED_PROXY_HOPS`. See
 * `docs/systems/web-security.md` section 9 and
 * `docs/systems/deployment.md`, "Server proxy-awareness".
 */
const trustedProxyHops = envCount('TRUSTED_PROXY_HOPS', 1);
if (trustedProxyHops > MAX_TRUSTED_PROXY_HOPS) {
  throw new Error(
    `TRUSTED_PROXY_HOPS is how many proxies in front of this app may be trusted to have written X-Forwarded-For, ` +
    `and it is what every rate limit keys on. Got ${trustedProxyHops}; the maximum is ${MAX_TRUSTED_PROXY_HOPS}. ` +
    `A CDN in front of your own reverse proxy in front of a tunnel is 3, so if you meant 1 or 2 this is a typo. ` +
    `If your deployment really has more than ${MAX_TRUSTED_PROXY_HOPS} hops, the cap in packages/server/src/config.ts ` +
    `is what to change, and we would like to hear about the topology.`
  );
}

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

  trustedProxyHops,

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

  updates: {
    /**
     * Whether the admin Updates panel may look up the newest release.
     *
     * There is no background poller anywhere in the server. The lookup happens
     * only while a signed-in admin has that panel open and the cache is cold,
     * so an instance whose admin never opens it never contacts github.com. This
     * switch exists for airgapped deployments and for operators who want the
     * guarantee rather than the behaviour.
     */
    checkEnabled: envBool('BACKSPACE_UPDATE_CHECK', true),
    /**
     * prebuilt | source | undefined. install.sh records this after its
     * pull-or-build decision resolves. Undefined on installs that predate it,
     * which the panel reports as unknown rather than guessing.
     */
    installChannel: envOptional('BACKSPACE_INSTALL_CHANNEL'),
  },
  telemetry: {
    /** Receiver base URL for the opt-in daily ping. Tests and a future move override it. */
    endpoint: envOptional('TELEMETRY_ENDPOINT') ?? 'https://hello.backspacechat.com',
  },
  directory: {
    /**
     * Hub base URL for the opt-in space directory. Unset means the project
     * hub. Set to an empty string to disable the pinger and the proxy
     * entirely (forks, air-gapped installs). Trailing slashes are dropped.
     *
     * Written out rather than through envOptional, which folds an empty
     * value into unset and would hand an operator who set '' the hub.
     */
    endpoint: process.env.DIRECTORY_ENDPOINT === undefined
      ? 'https://explore.backspacechat.com'
      : process.env.DIRECTORY_ENDPOINT.trim().replace(/\/+$/, ''),
  },
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
