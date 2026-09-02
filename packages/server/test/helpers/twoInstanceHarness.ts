import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SpawnedInstance {
  proc: ChildProcess;
  port: number;
  origin: string;        // 'http://127.0.0.1:<port>'
  domain: string;        // 'home.test.local' / 'remote0.test.local' / ...
  dbPath: string;
  storagePath: string;
  jwtSecret: string;
  logPath: string;
}

export interface MultiRemoteHarness {
  home: SpawnedInstance;
  remotes: SpawnedInstance[];
  runDir: string;
  cleanup: () => Promise<void>;
}

// Convenience type alias for the common one-remote case.
export interface TwoInstanceHarness {
  home: SpawnedInstance;
  remote: SpawnedInstance;
  remotes: SpawnedInstance[]; // for code that wants the array form
  runDir: string;
  cleanup: () => Promise<void>;
}

async function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not allocate ephemeral port')));
      }
    });
    srv.on('error', reject);
  });
}

// Ceiling on how long a spawned instance may take to answer /api/instance/info.
// Raised from 20s: the federation e2e suites run several files in parallel, each
// booting up to four instances, so a shared CI runner can have a dozen `tsx`
// processes competing during startup. This only bounds how long we wait before
// declaring failure — a healthy boot still returns as soon as it is ready — so a
// genuine hang is still caught well inside the 90-180s hook timeouts.
const READY_TIMEOUT_MS = 60_000;

async function waitForReady(origin: string, proc: ChildProcess, logPath: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Held in one object rather than two `let`s: TypeScript's control-flow
  // analysis does not track assignments made inside a callback, so a `let`
  // read after the loop narrows to its initializer and the fields below become
  // `never`. Property reads are not narrowed that way.
  const exit: { happened: boolean; code: number | null; signal: NodeJS.Signals | null } = {
    happened: false,
    code: null,
    signal: null,
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exit.happened = true;
    exit.code = code;
    exit.signal = signal;
  };
  proc.once('exit', onExit);
  try {
    while (Date.now() < deadline) {
      if (exit.happened) {
        throw new Error(
          `Instance ${origin} exited during boot (code=${exit.code}, signal=${exit.signal}). ` +
          `See log at ${logPath}`,
        );
      }
      try {
        const res = await fetch(`${origin}/api/instance/info`);
        if (res.ok) return;
      } catch {
        // not ready yet
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Instance ${origin} did not become ready within ${timeoutMs}ms. See log at ${logPath}`);
  } finally {
    proc.off('exit', onExit);
  }
}

export async function spawnInstance(opts: {
  domain: string;
  port: number;
  dbPath: string;
  storagePath: string;
  jwtSecret: string;
  logPath: string;
  disableRateLimits?: boolean;
  /**
   * When true, set `PUBLIC_ORIGIN=http://127.0.0.1:<port>` so this instance's
   * `getOurOrigin()` returns its TRANSPORT url instead of the identity
   * `https://<DOMAIN>`. Required by the real-handshake harness so a single real
   * `/peer/initiate`→`/peer/accept` creates one working, reachable peer row per
   * direction (keyed by the transport origin). Default off — existing callers
   * are unaffected. See realHandshake.ts and federationAuth.ts:187.
   */
  publicOriginAsTransport?: boolean;
  /**
   * When true, omit `DISABLE_FEDERATION_WORKERS` so the spawned instance runs
   * the real background workers — most importantly the outbox delivery loop
   * (1s tick), which is what actually POSTs queued DM relay events to peers.
   * Required by any test that asserts a relay *arrived* rather than merely that
   * it was queued. Default off — existing suites keep the quiet profile.
   */
  enableFederationWorkers?: boolean;
  /**
   * LiveKit credentials for this instance. `generateFederatedCallToken` mints a
   * JWT locally with `livekit-server-sdk`'s `AccessToken` and never contacts a
   * LiveKit server, so a synthetic key/secret is enough to exercise the whole
   * federated call-start path offline. Default: LiveKit blanked (voice off).
   */
  livekit?: { url: string; apiKey: string; apiSecret: string };
}): Promise<SpawnedInstance> {
  const origin = `http://127.0.0.1:${opts.port}`;
  const env: Record<string, string> = {
    ...process.env,
    NODE_ENV: 'test',
    ENABLE_TEST_ROUTES: '1',
    PORT: String(opts.port),
    HOST: '127.0.0.1',
    DOMAIN: opts.domain,
    DB_PATH: opts.dbPath,
    STORAGE_PATH: opts.storagePath,
    JWT_SECRET: opts.jwtSecret,
    LIVEKIT_URL: opts.livekit?.url ?? '',
    LIVEKIT_API_KEY: opts.livekit?.apiKey ?? '',
    LIVEKIT_API_SECRET: opts.livekit?.apiSecret ?? '',
    // Every instance in this harness binds 127.0.0.1, which is exactly the
    // LAN-only shape the flag exists for: an origin a caller asserted (a friend
    // handle, a peering callback) is otherwise required to resolve to a public
    // address before this instance will send anything to it. Set here and only
    // here — the shipped default is off, and .env.example documents it that way.
    FEDERATION_ALLOW_PRIVATE_PEERS: 'true',
  };
  // Explicit in BOTH branches: `env` starts as a copy of `process.env`, so an
  // inherited DISABLE_FEDERATION_WORKERS would otherwise silently re-disable the
  // workers a caller asked for.
  env.DISABLE_FEDERATION_WORKERS = opts.enableFederationWorkers ? '0' : '1';
  // Default: bypass rate limits so unrelated tests don't exhaust the per-IP
  // bucket on 127.0.0.1. Test #15 (rate-limit assertion) opts out via
  // bootTwoInstancesWithRateLimits().
  if (opts.disableRateLimits !== false) {
    env.DISABLE_RATE_LIMITS = '1';
  }
  if (opts.publicOriginAsTransport) {
    env.PUBLIC_ORIGIN = origin;
  }
  // From packages/server/test/helpers → packages/server is up two levels.
  const serverDir = path.resolve(__dirname, '../../');
  const proc = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logStream = createWriteStream(opts.logPath);
  proc.stdout!.pipe(logStream);
  proc.stderr!.pipe(logStream);
  await waitForReady(origin, proc, opts.logPath);
  return {
    proc,
    port: opts.port,
    origin,
    domain: opts.domain,
    dbPath: opts.dbPath,
    storagePath: opts.storagePath,
    jwtSecret: opts.jwtSecret,
    logPath: opts.logPath,
  };
}

export interface BootOptions {
  /**
   * If true, spawned instances do NOT receive `DISABLE_RATE_LIMITS=1`, so
   * `@fastify/rate-limit` enforces real per-IP/per-user buckets. Used only by
   * tests that assert rate-limit behaviour (Test #15). Default: false (bypass on).
   */
  enableRateLimits?: boolean;
  /**
   * If true, every spawned instance (home + all remotes) sets
   * `PUBLIC_ORIGIN=http://127.0.0.1:<its-port>` so `getOurOrigin()` returns the
   * transport url. Required by the real-handshake harness so a single real
   * handshake yields one reachable peer row per direction. Default: false.
   */
  publicOriginAsTransport?: boolean;
  /**
   * Run the real federation background workers (outbox delivery, recovery,
   * health check) on every instance. Needed only by tests that assert a queued
   * relay actually *arrives* at the peer. Default: false. See
   * `spawnInstance`'s option of the same name.
   */
  enableFederationWorkers?: boolean;
  /**
   * Give every instance the same synthetic LiveKit credentials, enabling the
   * federated call-start path (tokens are minted locally, no LiveKit server is
   * contacted). Default: false → LiveKit stays unconfigured.
   */
  enableLiveKit?: boolean;
}

/**
 * Synthetic LiveKit credentials used when `BootOptions.enableLiveKit` is set.
 * `AccessToken` only needs a key/secret pair to sign; nothing dials `url`.
 */
const TEST_LIVEKIT = {
  url: 'wss://livekit.test.local',
  apiKey: 'devkey',
  apiSecret: 'test-only-livekit-secret-not-for-production-use',
} as const;

/** Boot home + N remotes. All instances ready before the function returns. */
export async function bootHomePlusRemotes(
  remoteCount: number,
  options: BootOptions = {},
): Promise<MultiRemoteHarness> {
  if (remoteCount < 1) throw new Error('remoteCount must be >= 1');
  const disableRateLimits = !options.enableRateLimits;
  const publicOriginAsTransport = options.publicOriginAsTransport ?? false;
  const enableFederationWorkers = options.enableFederationWorkers ?? false;
  const livekit = options.enableLiveKit ? { ...TEST_LIVEKIT } : undefined;
  const runId = crypto.randomBytes(4).toString('hex');
  // From packages/server/test/helpers → repo root is up four levels: helpers → test → server → packages → repo-root.
  const runDir = path.resolve(__dirname, `../../../../tests/.tmp/${runId}`);
  await mkdir(`${runDir}/home-uploads`, { recursive: true });

  const homePort = await allocateEphemeralPort();
  const home = await spawnInstance({
    domain: 'home.test.local',
    port: homePort,
    dbPath: `${runDir}/home.db`,
    storagePath: `${runDir}/home-uploads`,
    jwtSecret: crypto.randomBytes(32).toString('hex'),
    logPath: `${runDir}/home.log`,
    disableRateLimits,
    publicOriginAsTransport,
    enableFederationWorkers,
    livekit,
  });

  const remotes: SpawnedInstance[] = [];
  for (let i = 0; i < remoteCount; i++) {
    await mkdir(`${runDir}/remote${i}-uploads`, { recursive: true });
    const port = await allocateEphemeralPort();
    const r = await spawnInstance({
      domain: `remote${i}.test.local`,
      port,
      dbPath: `${runDir}/remote${i}.db`,
      storagePath: `${runDir}/remote${i}-uploads`,
      jwtSecret: crypto.randomBytes(32).toString('hex'),
      logPath: `${runDir}/remote${i}.log`,
      disableRateLimits,
      publicOriginAsTransport,
      enableFederationWorkers,
      livekit,
    });
    remotes.push(r);
  }

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const inst of [home, ...remotes]) {
      if (!inst.proc.killed) {
        inst.proc.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        if (!inst.proc.killed) inst.proc.kill('SIGKILL');
      }
    }
    await rm(runDir, { recursive: true, force: true });
  };

  return { home, remotes, runDir, cleanup };
}

/** Convenience: 1 home + 1 remote. Exposes both `remote` (singular) and `remotes` (array). */
export async function bootTwoInstances(options: BootOptions = {}): Promise<TwoInstanceHarness> {
  const m = await bootHomePlusRemotes(1, options);
  return {
    home: m.home,
    // bootHomePlusRemotes(1) always yields exactly one remote.
    remote: m.remotes[0]!,
    remotes: m.remotes,
    runDir: m.runDir,
    cleanup: m.cleanup,
  };
}

/**
 * Variant of `bootTwoInstances` that does NOT set `DISABLE_RATE_LIMITS`, so the
 * spawned instances enforce real `@fastify/rate-limit` buckets. Used by Test #15
 * (rate-limit assertion) ONLY — every other test should use `bootTwoInstances` /
 * `bootHomePlusRemotes` so unrelated tests don't exhaust the shared loopback IP
 * bucket. Same shape as `bootTwoInstances`, just with a different env profile.
 */
export async function bootTwoInstancesWithRateLimits(): Promise<TwoInstanceHarness> {
  return bootTwoInstances({ enableRateLimits: true });
}

/**
 * Read the contents of an instance's log file. Used by tests that need to assert
 * a specific request did or did not reach an instance (Task 14 / Test #1).
 */
export async function readInstanceLog(inst: SpawnedInstance): Promise<string> {
  try {
    return await readFile(inst.logPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Wait `delayMs` (to let any in-flight request settle into the log file), then
 * return whether `pattern` appears in `inst`'s log. Used to prove a request did
 * NOT happen — assert the result is false.
 */
export async function logMatched(inst: SpawnedInstance, pattern: RegExp, delayMs = 1_000): Promise<boolean> {
  await new Promise(r => setTimeout(r, delayMs));
  const log = await readInstanceLog(inst);
  return pattern.test(log);
}
