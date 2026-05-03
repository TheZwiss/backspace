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

async function waitForReady(origin: string, proc: ChildProcess, logPath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited = true;
    exitInfo = { code, signal };
  };
  proc.once('exit', onExit);
  try {
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `Instance ${origin} exited during boot (code=${exitInfo?.code}, signal=${exitInfo?.signal}). ` +
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

async function spawnInstance(opts: {
  domain: string;
  port: number;
  dbPath: string;
  storagePath: string;
  jwtSecret: string;
  logPath: string;
}): Promise<SpawnedInstance> {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    ENABLE_TEST_ROUTES: '1',
    DISABLE_FEDERATION_WORKERS: '1',
    PORT: String(opts.port),
    HOST: '127.0.0.1',
    DOMAIN: opts.domain,
    DB_PATH: opts.dbPath,
    STORAGE_PATH: opts.storagePath,
    JWT_SECRET: opts.jwtSecret,
    LIVEKIT_URL: '',
    LIVEKIT_API_KEY: '',
    LIVEKIT_API_SECRET: '',
  };
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
  const origin = `http://127.0.0.1:${opts.port}`;
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

/** Boot home + N remotes. All instances ready before the function returns. */
export async function bootHomePlusRemotes(remoteCount: number): Promise<MultiRemoteHarness> {
  if (remoteCount < 1) throw new Error('remoteCount must be >= 1');
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
export async function bootTwoInstances(): Promise<TwoInstanceHarness> {
  const m = await bootHomePlusRemotes(1);
  return {
    home: m.home,
    remote: m.remotes[0],
    remotes: m.remotes,
    runDir: m.runDir,
    cleanup: m.cleanup,
  };
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
