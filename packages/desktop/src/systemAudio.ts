/**
 * System audio for a screen share without Backspace's own playback (#358).
 *
 * Chromium can leave the app out of a loopback capture only on Windows 11 and
 * macOS 14.2+ (docs/systems/voice.md, "System Audio Loopback"). On Linux the
 * capture is the monitor of the whole mix, so the voices Backspace plays come
 * back to the viewers. Here the capture is built from the other side: PipeWire
 * is asked (through `@vencord/venmic`, the module Vesktop uses) to route every
 * playback stream except Backspace's own into a virtual source, and the web
 * client opens that source like a microphone.
 *
 * This file only decides what to exclude and drives the link; the PipeWire
 * work is venmic's. The module is an optional dependency that exists on Linux
 * only, so it is loaded lazily and everything here degrades to "unavailable".
 */

/** Name venmic gives the virtual source; the web client finds the device by it. */
export const SYSTEM_AUDIO_SOURCE_LABEL = 'vencord-screen-share';

/** A PipeWire node's properties, matched by exact string equality. */
export type NodeMatch = Record<string, string>;

/** The part of `@vencord/venmic`'s `PatchBay` used here. */
export interface PatchBayLike {
  list?(props: string[]): NodeMatch[];
  link(data: { include?: NodeMatch[]; exclude: NodeMatch[]; only_speakers: boolean; only_default_speakers: boolean; mute: boolean; ignore_devices: boolean }): boolean;
  unlink(): void;
}

export interface PatchBayModule {
  PatchBay: (new () => PatchBayLike) & { hasPipeWire(): boolean };
}

export type SystemAudioStart =
  | { ok: true; label: string }
  | { ok: false; reason: 'unsupported-platform' | 'sandboxed' | 'module-missing' | 'no-pipewire' | 'link-failed' | 'audio-target-required' };

export interface SystemAudioController {
  /** Whether `start` can work on this machine (platform, module, PipeWire). The module load is cached, the probe is not: PipeWire may come up later. */
  isAvailable(): boolean;
  targets(): Array<{ id: string; name: string }>;
  start(targetId?: string): SystemAudioStart;
  stop(): void;
}

export interface SystemAudioDeps {
  platform: NodeJS.Platform;
  loadModule: () => PatchBayModule;
  /** Pids of every process of this Electron app (`app.getAppMetrics()`). */
  getPids: () => number[];
  /** `process.execPath`: the binary every Electron process of the app runs. */
  executablePath: string;
  /**
   * True where the app runs in a sandbox (Flatpak) whose PipeWire access has not been
   * checked against venmic: the Chromium loopback stays in use there.
   */
  isSandboxed?: () => boolean;
  log?: (message: string, ...args: unknown[]) => void;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * What to keep out of the virtual source. Matches are OR'd between entries and
 * AND'd inside one. The playback stream belongs to Chromium's audio-service
 * process, so each of the app's pids is listed; the binary name is added as
 * well because a sandboxed process can report a pid from its own namespace,
 * which no list of host pids would match.
 */
export function buildExcludeNodes(pids: readonly number[], executablePath: string): NodeMatch[] {
  const nodes: NodeMatch[] = [...new Set(pids)]
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => ({ 'application.process.id': String(pid) }));
  const binary = baseName(executablePath);
  if (binary) nodes.push({ 'application.process.binary': binary });
  // A virtual DSP/monitor may already contain Backspace mixed with other apps.
  // Capture original application streams, never feed that aggregate back in.
  nodes.push({ 'node.virtual': 'true' }, { 'media.class': 'Stream/Input/Audio' });
  return nodes;
}

export function createSystemAudioController(deps: SystemAudioDeps): SystemAudioController {
  const log = deps.log ?? (() => undefined);
  let module: PatchBayModule | null | undefined;
  let bay: PatchBayLike | null = null;
  let linked = false;

  function load(): PatchBayModule | null {
    if (module !== undefined) return module;
    if (deps.platform !== 'linux') return (module = null);
    try {
      module = deps.loadModule();
    } catch (err) {
      log('venmic could not be loaded:', err);
      module = null;
    }
    return module;
  }

  function reason(): Extract<SystemAudioStart, { ok: false }>['reason'] | null {
    if (deps.platform !== 'linux') return 'unsupported-platform';
    if (deps.isSandboxed?.()) return 'sandboxed';
    const loaded = load();
    if (!loaded) return 'module-missing';
    try {
      if (!loaded.PatchBay.hasPipeWire()) return 'no-pipewire';
    } catch (err) {
      log('PipeWire probe failed:', err);
      return 'no-pipewire';
    }
    return null;
  }

  return {
    isAvailable: () => reason() === null,

    targets() {
      if (reason()) return [];
      try {
        bay ??= new (module as PatchBayModule).PatchBay();
        const excluded = new Set(deps.getPids().map(String));
        const nodes = bay.list?.([]) ?? [];
        const targets = new Map<string, string>();
        for (const node of nodes) {
          const pid = node['application.process.id'];
          if (node['node.virtual'] === 'true' || node['media.class'] !== 'Stream/Output/Audio' || (pid && excluded.has(pid))) continue;
          if (buildExcludeNodes(deps.getPids(), deps.executablePath).some((match) => Object.entries(match).every(([key, value]) => node[key] === value))) continue;
          const serial = node['object.serial'];
          const id = pid || (serial && /^\d+$/.test(serial) ? `node:${serial}` : null);
          if (id) targets.set(id, node['application.name'] || node['node.name'] || id);
        }
        return [...targets].map(([id, name]) => ({ id, name }));
      } catch { return []; }
    },

    start(targetId?: string): SystemAudioStart {
      const unavailable = reason();
      if (unavailable) return { ok: false, reason: unavailable };
      try {
        bay ??= new (module as PatchBayModule).PatchBay();
        // A second start relinks with the pids as they are now.
        const ok = bay.link({
          include: [{ 'media.class': 'Stream/Output/Audio', ...(targetId ? (targetId.startsWith('node:') ? { 'object.serial': targetId.slice(5) } : { 'application.process.id': targetId }) : {}) }],
          exclude: buildExcludeNodes(deps.getPids(), deps.executablePath),
          only_speakers: false,
          only_default_speakers: false,
          mute: false,
          ignore_devices: true,
        });
        linked = ok;
        if (!ok) return { ok: false, reason: 'link-failed' };
        return { ok: true, label: SYSTEM_AUDIO_SOURCE_LABEL };
      } catch (err) {
        log('venmic link failed:', err);
        linked = false;
        return { ok: false, reason: 'link-failed' };
      }
    },

    stop(): void {
      if (!bay || !linked) return;
      linked = false;
      try {
        bay.unlink();
      } catch (err) {
        log('venmic unlink failed:', err);
      }
    },
  };
}

/**
 * `ownAudioInSystemAudio()` describes what Chromium's loopback does. A web
 * client that opens the source this module builds says so when it asks
 * (`clientUsesSource`), and for it Backspace's own playback is left out
 * whatever the OS table says. A web client from before the source never opens
 * it and keeps the loopback, so it gets the OS verdict, and the module is not
 * loaded for it. Only `true` counts: the argument comes from the renderer.
 */
export function withSystemAudioSource<T extends string>(
  base: T,
  clientUsesSource: unknown,
  sourceAvailable: () => boolean,
): T | 'excluded' {
  return clientUsesSource === true && sourceAvailable() ? 'excluded' : base;
}
