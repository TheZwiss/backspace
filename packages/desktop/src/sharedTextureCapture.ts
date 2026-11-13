import { app, sharedTexture, type WebContents, type SharedTextureImported } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GameCaptureRequest } from './gameCapture';

interface CaptureSession {
  owner: WebContents;
  child: ChildProcessWithoutNullStreams;
  request: GameCaptureRequest;
  stopping: Promise<void> | null;
}
const sessions = new Map<string, CaptureSession>();
let startQueue = Promise.resolve();

function executable(): string | undefined {
  return [
    path.join(process.resourcesPath, 'shared-texture', process.arch, 'backspace-shared-texture.exe'),
    path.join(app.getAppPath(), 'native', 'shared-texture', 'bin', process.arch, 'backspace-shared-texture.exe'),
  ].find(candidate => fs.existsSync(candidate));
}

export function sharedTextureAvailable(): boolean {
  return process.platform === 'win32' && typeof sharedTexture?.importSharedTexture === 'function' && !!executable();
}

export function stopSharedTextureCapture(id: string, owner?: WebContents): Promise<void> {
  const session = sessions.get(id);
  if (!session || (owner && session.owner !== owner)) return Promise.resolve();
  if (session.stopping) return session.stopping;
  session.stopping = new Promise(resolve => {
    const { child } = session;
    if (!session.owner.isDestroyed()) session.owner.send('shared-texture-config', id, null);
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sessions.delete(id);
      resolve();
    };
    const timer = setTimeout(() => { child.kill(); }, 1500);
    timer.unref();
    child.once('exit', done);
    child.once('error', done);
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) done();
    else child.stdin.end('quit\n');
  });
  return session.stopping;
}

export async function stopAllSharedTextureCaptures(): Promise<void> {
  await Promise.all([...sessions.keys()].map(id => stopSharedTextureCapture(id)));
}

export function updateSharedTextureCapture(id: string, owner: WebContents, input: unknown): void {
  const session = sessions.get(id);
  if (!session || session.owner !== owner || session.stopping || !input || typeof input !== 'object') return;
  const values = input as Record<string, unknown>;
  const request = session.request;
  for (const [key, maximum] of [['width', 7680], ['height', 4320]] as const) {
    if (values[key] === null) request[key] = undefined;
    else if (typeof values[key] === 'number' && Number.isFinite(values[key])) request[key] = Math.max(16, Math.min(maximum, Math.floor(values[key] as number / 2) * 2));
  }
  if (typeof values.frameRate === 'number' && Number.isFinite(values.frameRate)) {
    request.frameRate = Math.max(1, Math.min(120, Math.round(values.frameRate)));
    if (session.child.stdin.writable) session.child.stdin.write(`fps ${request.frameRate}\n`);
  }
  if (['auto', 'show', 'hide'].includes(String(values.cursorMode))) request.cursorMode = values.cursorMode as GameCaptureRequest['cursorMode'];
  owner.send('shared-texture-config', id, request);
}

export function startSharedTextureCapture(owner: WebContents, request: GameCaptureRequest): Promise<{ id: string; transport: 'shared-texture' } | null> {
  const result = startQueue.then(() => startCapture(owner, request));
  startQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function startCapture(owner: WebContents, request: GameCaptureRequest): Promise<{ id: string; transport: 'shared-texture' } | null> {
  const helper = executable();
  if (!sharedTextureAvailable() || !helper || request.encodingDevice === 'cpu' || owner.isDestroyed()) return null;
  await stopAllSharedTextureCaptures();
  if (owner.isDestroyed()) return null;
  const id = crypto.randomBytes(16).toString('hex');
  const child = spawn(helper, [String(process.pid), String(request.monitorIndex ?? 0), String(request.frameRate)], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const session: CaptureSession = { owner, child, request, stopping: null };
  sessions.set(id, session);
  owner.send('shared-texture-config', id, request);
  child.stdin.on('error', () => undefined);
  const fail = (): void => {
    if (session.stopping) return;
    if (!owner.isDestroyed()) owner.send('shared-texture-error', id);
    void stopSharedTextureCapture(id);
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stderr.on('data', () => undefined);
  createInterface({ input: child.stdout }).on('line', line => {
    if (session.stopping) return;
    void (async () => {
      let imported: SharedTextureImported | undefined;
      try {
        const info = JSON.parse(line);
        if (info.error || owner.isDestroyed()) { fail(); return; }
        if (!Number.isInteger(info.slot) || info.slot < 0 || info.slot >= 3
            || !Number.isInteger(info.width) || info.width < 16 || info.width > 32768
            || !Number.isInteger(info.height) || info.height < 16 || info.height > 32768
            || !Number.isFinite(info.timestamp)) { fail(); return; }
        const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(info.handle));
        imported = sharedTexture.importSharedTexture({
          textureInfo: { pixelFormat: 'bgra', codedSize: { width: info.width, height: info.height },
            visibleRect: { x: 0, y: 0, width: info.width, height: info.height },
            handle: { ntHandle: handle }, timestamp: info.timestamp },
          allReferencesReleased: () => {
            if (!session.stopping && child.stdin.writable) child.stdin.write(`release ${info.slot}\n`);
          },
        });
        await sharedTexture.sendSharedTexture({ frame: owner.mainFrame, importedSharedTexture: imported },
          { id, sequence: info.sequence, cursor: info.cursor, poolDrops: info.poolDrops });
      } catch { fail(); }
      finally { imported?.release(); }
    })();
  });
  return { id, transport: 'shared-texture' };
}
