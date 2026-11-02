import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';

export interface GameCaptureRequest {
  sourceId: string;
  displaySourceId?: string;
  monitorIndex?: number;
  frameRate: number;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  bitrateKbps?: number;
  cursorMode?: 'auto' | 'show' | 'hide';
  encodingDevice?: 'gpu' | 'cpu';
  crop?: { x: number; y: number; width: number; height: number };
}

export interface GameCaptureSession {
  id: string;
  url: string;
}

type Encoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';
interface CaptureBackend { executable: string; encoder: Encoder }
interface ActiveSession extends GameCaptureRequest { child: ChildProcess | null; connected: boolean }

const sessions = new Map<string, ActiveSession>();
let captureServer: http.Server | null = null;
let captureServerPort: Promise<number> | null = null;
let captureBackend: Promise<CaptureBackend | null> | null = null;

function normalizeFrameRate(value: number): number {
  if (!Number.isFinite(value)) return 30;
  const rounded = Math.round(value);
  return Math.min(120, Math.max(1, rounded || 30));
}

export function isValidDisplayCaptureRequest(sourceId: unknown, displaySourceId?: unknown): boolean {
  return typeof sourceId === 'string'
    && /^screen:\d+:\d+$/.test(sourceId)
    && (displaySourceId === undefined || displaySourceId === sourceId);
}

function captureSource(request: GameCaptureRequest): string {
  const monitor = Number.isSafeInteger(request.monitorIndex) && (request.monitorIndex ?? -1) >= 0
    ? request.monitorIndex : 0;
  const crop = request.crop && request.crop.width >= 16 && request.crop.height >= 16 ? request.crop : null;
  const options = [
    `output_idx=${monitor}`,
    // The renderer resolves Auto to Hide for game windows. Keep the native
    // desktop cursor visible for Auto and Show so ordinary desktop sharing
    // does not hide it.
    `draw_mouse=${request.cursorMode === 'hide' ? 0 : 1}`,
    `framerate=${normalizeFrameRate(request.frameRate)}`,
    ...(crop ? [
      `offset_x=${Math.max(0, Math.round(crop.x))}`,
      `offset_y=${Math.max(0, Math.round(crop.y))}`,
      `video_size=${Math.max(2, Math.round(crop.width))}x${Math.max(2, Math.round(crop.height))}`,
    ] : []),
  ];
  return `ddagrab=${options.join(':')}`;
}

export function buildGameCaptureArgs(request: GameCaptureRequest, encoder: Encoder = 'libx264'): string[] {
  const fps = normalizeFrameRate(request.frameRate);
  const requestedBitrate = Number.isFinite(request.bitrateKbps) ? request.bitrateKbps! : 6_000;
  const bitrate = Math.min(50_000, Math.max(1_000, Math.round(requestedBitrate)));
  const width = Number.isFinite(request.width) && (request.width ?? 0) >= 16
    ? Math.min(7680, Math.floor(request.width! / 2) * 2) : 0;
  const height = Number.isFinite(request.height) && (request.height ?? 0) >= 16
    ? Math.min(4320, Math.floor(request.height! / 2) * 2) : 0;
  const resize = !!width && !!height && (width !== request.sourceWidth || height !== request.sourceHeight);
  const encoderArgs = encoder === 'h264_nvenc'
    ? ['-c:v', encoder, '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-bf', '0', '-rc-lookahead', '0', '-rc', 'cbr']
    : encoder === 'h264_qsv' ? ['-c:v', encoder, '-preset', 'veryfast']
      : encoder === 'h264_amf' ? ['-c:v', encoder, '-quality', 'speed']
        : ['-c:v', encoder, '-preset', 'ultrafast', '-tune', 'zerolatency'];
  return [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', captureSource(request),
    '-vf', encoder === 'h264_nvenc'
      ? (resize ? `hwdownload,format=bgra,scale=${width}:${height},format=nv12` : 'format=d3d11')
      : `hwdownload,format=bgra${resize ? `,scale=${width}:${height}` : ''}`,
    '-an', ...encoderArgs, '-profile:v', 'baseline',
    ...(encoder === 'h264_nvenc' ? [] : ['-pix_fmt', 'yuv420p']),
    '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate}k`,
    '-g', String(Math.max(1, Math.round(fps / 2))), '-flush_packets', '1',
    '-bsf:v', 'h264_metadata=aud=insert', '-f', 'h264', 'pipe:1',
  ];
}

function execFileOutput(executable: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function addFfmpegFiles(output: Set<string>, root: string, depth: number): Promise<void> {
  if (depth < 0) return;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'ffmpeg.exe') output.add(candidate);
    else if (entry.isDirectory()) await addFfmpegFiles(output, candidate, depth - 1);
  }
}

async function supportsDdagrab(executable: string): Promise<boolean> {
  try {
    const result = await execFileOutput(executable, ['-hide_banner', '-filters'], 5_000);
    return result.includes('ddagrab');
  } catch { return false; }
}

async function encoderWorks(executable: string, encoder: Encoder): Promise<boolean> {
  try {
    await execFileOutput(executable, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=1',
      '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-',
    ], 10_000);
    return true;
  } catch { return false; }
}

export function resolveGameCaptureBackend(): Promise<CaptureBackend | null> {
  if (captureBackend) return captureBackend;
  captureBackend = Promise.resolve().then(async () => {
    const immediateCandidates = new Set<string>();
    if (process.env.BACKSPACE_FFMPEG_PATH) immediateCandidates.add(process.env.BACKSPACE_FFMPEG_PATH);
    if (process.resourcesPath) {
      immediateCandidates.add(path.join(process.resourcesPath, 'ffmpeg.exe'));
      immediateCandidates.add(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
    }
    immediateCandidates.add(path.join(app.getAppPath(), 'resources', 'ffmpeg.exe'));
    immediateCandidates.add(path.join(app.getAppPath(), 'resources', 'ffmpeg', 'ffmpeg.exe'));
    if (process.env.LOCALAPPDATA) {
      immediateCandidates.add(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
    }

    const probeCandidates = async (candidates: Iterable<string>): Promise<CaptureBackend | null> => {
      for (const executable of candidates) {
        try { await fs.promises.access(executable); } catch { continue; }
        if (!await supportsDdagrab(executable)) continue;
        let encoder: Encoder | undefined;
        for (const candidate of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'] as Encoder[]) {
          if (await encoderWorks(executable, candidate)) { encoder = candidate; break; }
        }
        if (encoder) return { executable, encoder };
      }
      return null;
    };

    // Test explicit, packaged and WinGet Links executables immediately.
    const immediateBackend = await probeCandidates(immediateCandidates);
    if (immediateBackend) return immediateBackend;

    // `where.exe` is cheap compared with walking every WinGet package folder.
    const pathCandidates = new Set<string>();
    try {
      const found = await execFileOutput('where.exe', ['ffmpeg'], 5_000);
      for (const line of found.split(/\r?\n/)) if (line.trim()) pathCandidates.add(line.trim());
    } catch { /* Native capture remains optional; Chromium is the fallback. */ }
    const pathBackend = await probeCandidates(pathCandidates);
    if (pathBackend) return pathBackend;

    if (!process.env.LOCALAPPDATA) return null;
    const packagedCandidates = new Set<string>();
    await addFfmpegFiles(
      packagedCandidates,
      path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages'),
      5,
    );
    return probeCandidates(packagedCandidates);
  });
  return captureBackend;
}

function attachChild(id: string, session: ActiveSession, response: http.ServerResponse, child: ChildProcess): void {
  session.child = child;
  child.stdout?.pipe(response);
  child.stderr?.on('data', (chunk: Buffer) => {
    const message = chunk.toString('utf8').trim();
    if (message) console.warn('[GameCapture] FFmpeg:', message);
  });
  child.on('error', (error) => {
    console.warn('[GameCapture] FFmpeg failed:', error.message);
    response.end();
  });
  child.on('exit', () => {
    if (session.child === child) session.child = null;
    if (sessions.get(id) === session) sessions.delete(id);
    if (!response.writableEnded) response.end();
  });
  response.on('close', () => {
    if (session.child === child) session.child = null;
    if (sessions.get(id) === session) sessions.delete(id);
    child.kill();
  });
}

function ensureCaptureServer(): Promise<number> {
  if (captureServerPort) return captureServerPort;
  captureServerPort = new Promise<number>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const match = /^\/capture\/([a-f0-9]{32})$/.exec(url.pathname);
      const id = match?.[1];
      const active = id ? sessions.get(id) : undefined;
      if (request.method !== 'GET' || !active) { response.writeHead(404).end(); return; }
      if (active.connected) { response.writeHead(409).end(); return; }
      active.connected = true;
      const origin = request.headers.origin;
      // The web client can be served by a self-hosted instance. The unguessable
      // per-session URL is the capability; reflect that document's origin so
      // Electron's renderer can read the H.264 response through fetch().
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'video/h264');
      response.setHeader('X-Backspace-Codec', 'avc1.42E01E');
      response.setHeader('Access-Control-Expose-Headers', 'X-Backspace-Codec');
      void resolveGameCaptureBackend().then((backend) => {
        if (!backend || !id || !sessions.has(id) || response.destroyed) {
          if (id && sessions.get(id) === active) sessions.delete(id);
          if (!response.destroyed) response.writeHead(503).end();
          return;
        }
        const encoder = active.encodingDevice === 'cpu' ? 'libx264' : backend.encoder;
        const child = spawn(backend.executable, buildGameCaptureArgs(active, encoder), {
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        attachChild(id, active, response, child);
      }).catch((error: unknown) => {
        console.warn('[GameCapture] Backend initialization failed:', error);
        if (!response.destroyed) response.writeHead(503).end();
      });
      response.on('close', () => {
        if (active.child) { active.child.kill(); active.child = null; }
      });
    });
    captureServer = server;
    server.on('error', (error) => { captureServer = null; captureServerPort = null; reject(error); });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Native capture server failed to bind')); return; }
      server.unref();
      resolve(address.port);
    });
  });
  return captureServerPort;
}

/** Starts an optional DXGI display capture. Window IDs are rejected to avoid leaking occluding windows. */
export async function startGameCapture(request: GameCaptureRequest): Promise<GameCaptureSession | null> {
  if (process.platform !== 'win32' || !isValidDisplayCaptureRequest(request.sourceId, request.displaySourceId)) return null;
  if (!(await resolveGameCaptureBackend())) return null;
  const port = await ensureCaptureServer();
  const id = crypto.randomBytes(16).toString('hex');
  sessions.set(id, { ...request, child: null, connected: false });
  return { id, url: `http://127.0.0.1:${port}/capture/${id}` };
}

export function stopGameCapture(id: string): void {
  const active = sessions.get(id);
  if (!active) return;
  active.child?.kill();
  sessions.delete(id);
}

export function stopAllGameCaptures(): void {
  for (const session of sessions.values()) session.child?.kill();
  sessions.clear();
  captureServer?.close();
  captureServer = null;
  captureServerPort = null;
  captureBackend = null;
}
