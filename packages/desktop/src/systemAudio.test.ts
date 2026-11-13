import { describe, it, expect, vi } from 'vitest';
import {
  SYSTEM_AUDIO_SOURCE_LABEL,
  buildExcludeNodes,
  createSystemAudioController,
  withSystemAudioSource,
  type PatchBayLike,
  type PatchBayModule,
  type SystemAudioDeps,
} from './systemAudio';

/**
 * #358: on Linux Chromium's loopback is the monitor of the whole mix, so the
 * voices Backspace plays reach the viewers. The controller routes every other
 * app's playback into a virtual source instead, and keeps Backspace's own
 * processes out of it.
 */

function fakeModule(options: { pipewire?: boolean; linkResult?: boolean } = {}) {
  const link = vi.fn<PatchBayLike['link']>(() => options.linkResult ?? true);
  const unlink = vi.fn();
  const constructed = vi.fn();
  class PatchBay implements PatchBayLike {
    constructor() {
      constructed();
    }
    link = link;
    unlink = unlink;
    static hasPipeWire(): boolean {
      return options.pipewire ?? true;
    }
  }
  const module: PatchBayModule = { PatchBay };
  return { module, link, unlink, constructed };
}

function controller(overrides: Partial<SystemAudioDeps> = {}) {
  const fake = fakeModule();
  const deps: SystemAudioDeps = {
    platform: 'linux',
    loadModule: () => fake.module,
    getPids: () => [4100, 4101, 4102],
    executablePath: '/opt/Backspace/backspace',
    ...overrides,
  };
  return { ...fake, ctl: createSystemAudioController(deps) };
}

describe('buildExcludeNodes', () => {
  it('lists every pid of the app and its binary name', () => {
    expect(buildExcludeNodes([10, 11], '/opt/Backspace/backspace')).toEqual([
      { 'application.process.id': '10' },
      { 'application.process.id': '11' },
      { 'application.process.binary': 'backspace' },
      { 'node.virtual': 'true' }, { 'media.class': 'Stream/Input/Audio' },
    ]);
  });

  it('drops duplicates and values that are not pids', () => {
    expect(buildExcludeNodes([10, 10, 0, -3, 1.5, Number.NaN], '/x/app')).toEqual([
      { 'application.process.id': '10' },
      { 'application.process.binary': 'app' },
      { 'node.virtual': 'true' }, { 'media.class': 'Stream/Input/Audio' },
    ]);
  });

  it('reads the binary name from a Windows-style path and omits it when there is none', () => {
    expect(buildExcludeNodes([], 'C:\\Program Files\\Backspace\\Backspace.exe')).toEqual([
      { 'application.process.binary': 'Backspace.exe' },
      { 'node.virtual': 'true' }, { 'media.class': 'Stream/Input/Audio' },
    ]);
    expect(buildExcludeNodes([7], '')).toEqual([{ 'application.process.id': '7' }, { 'node.virtual': 'true' }, { 'media.class': 'Stream/Input/Audio' }]);
  });
});

describe('createSystemAudioController', () => {
  it('links everything except the app and names the virtual source', () => {
    const { ctl, link } = controller();
    expect(ctl.isAvailable()).toBe(true);
    expect(ctl.start()).toEqual({ ok: true, label: SYSTEM_AUDIO_SOURCE_LABEL });
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith({
      include: [{ 'media.class': 'Stream/Output/Audio' }],
      exclude: [
        { 'application.process.id': '4100' },
        { 'application.process.id': '4101' },
        { 'application.process.id': '4102' },
        { 'application.process.binary': 'backspace' },
      { 'node.virtual': 'true' }, { 'media.class': 'Stream/Input/Audio' },
      ],
      only_speakers: false,
      only_default_speakers: false,
      mute: false,
      ignore_devices: true,
    });
  });

  it('is unavailable off Linux without loading the module', () => {
    const loadModule = vi.fn();
    const { ctl } = controller({ platform: 'win32', loadModule });
    expect(ctl.isAvailable()).toBe(false);
    expect(ctl.start()).toEqual({ ok: false, reason: 'unsupported-platform' });
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('reports a missing module once and keeps working without it', () => {
    const log = vi.fn();
    const loadModule = vi.fn(() => {
      throw new Error('Cannot find module');
    });
    const { ctl } = controller({ loadModule, log });
    expect(ctl.start()).toEqual({ ok: false, reason: 'module-missing' });
    expect(ctl.isAvailable()).toBe(false);
    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(() => ctl.stop()).not.toThrow();
  });

  it('is unavailable in a sandbox, without loading the module', () => {
    const loadModule = vi.fn();
    const { ctl } = controller({ loadModule, isSandboxed: () => true });
    expect(ctl.isAvailable()).toBe(false);
    expect(ctl.start()).toEqual({ ok: false, reason: 'sandboxed' });
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('is unavailable on a PulseAudio-only system', () => {
    const fake = fakeModule({ pipewire: false });
    const ctl = createSystemAudioController({
      platform: 'linux',
      loadModule: () => fake.module,
      getPids: () => [1],
      executablePath: '/x/app',
    });
    expect(ctl.isAvailable()).toBe(false);
    expect(ctl.start()).toEqual({ ok: false, reason: 'no-pipewire' });
    expect(fake.link).not.toHaveBeenCalled();
  });

  it('treats a failing PipeWire probe as no PipeWire', () => {
    const module: PatchBayModule = {
      PatchBay: class {
        link(): boolean {
          return true;
        }
        unlink(): void {}
        static hasPipeWire(): boolean {
          throw new Error('probe failed');
        }
      },
    };
    const ctl = createSystemAudioController({
      platform: 'linux',
      loadModule: () => module,
      getPids: () => [1],
      executablePath: '/x/app',
      log: () => undefined,
    });
    expect(ctl.start()).toEqual({ ok: false, reason: 'no-pipewire' });
  });

  it('reports a link that venmic refuses, or that throws', () => {
    const refused = fakeModule({ linkResult: false });
    const ctlRefused = createSystemAudioController({
      platform: 'linux',
      loadModule: () => refused.module,
      getPids: () => [1],
      executablePath: '/x/app',
    });
    expect(ctlRefused.start()).toEqual({ ok: false, reason: 'link-failed' });
    ctlRefused.stop();
    expect(refused.unlink).not.toHaveBeenCalled();

    const thrown = fakeModule();
    thrown.link.mockImplementation(() => {
      throw new Error('pipewire gone');
    });
    const ctlThrown = createSystemAudioController({
      platform: 'linux',
      loadModule: () => thrown.module,
      getPids: () => [1],
      executablePath: '/x/app',
      log: () => undefined,
    });
    expect(ctlThrown.start()).toEqual({ ok: false, reason: 'link-failed' });
  });

  it('unlinks once on stop and not at all when nothing was linked', () => {
    const { ctl, unlink } = controller();
    ctl.stop();
    expect(unlink).not.toHaveBeenCalled();
    ctl.start();
    ctl.stop();
    ctl.stop();
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('reuses one PatchBay and relinks with the pids of the moment', () => {
    let pids = [10];
    const { ctl, link, constructed } = controller({ getPids: () => pids });
    ctl.start();
    pids = [10, 20];
    ctl.start();
    expect(constructed).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledTimes(2);
    expect(link.mock.calls[1]![0].exclude).toContainEqual({ 'application.process.id': '20' });
  });

  it('survives an unlink that throws', () => {
    const { ctl, unlink } = controller({ log: () => undefined });
    ctl.start();
    unlink.mockImplementation(() => {
      throw new Error('already gone');
    });
    expect(() => ctl.stop()).not.toThrow();
  });
});

describe('withSystemAudioSource', () => {
  it('says the app is left out when the client uses the source and it can be built', () => {
    expect(withSystemAudioSource('included', true, () => true)).toBe('excluded');
    expect(withSystemAudioSource('included', true, () => false)).toBe('included');
    expect(withSystemAudioSource('unavailable', true, () => false)).toBe('unavailable');
  });

  it('gives a client that does not use the source the OS verdict, without probing for it', () => {
    // A web client from before the source keeps Chromium's loopback, which carries the app.
    const available = vi.fn(() => true);
    expect(withSystemAudioSource('included', undefined, available)).toBe('included');
    expect(withSystemAudioSource('included', false, available)).toBe('included');
    expect(withSystemAudioSource('included', 'true', available)).toBe('included');
    expect(available).not.toHaveBeenCalled();
  });
});

describe('application-only PipeWire capture', () => {
  it('includes only the selected audio process while retaining Backspace exclusions', () => {
    const { ctl, link } = controller();
    expect(ctl.start('1234').ok).toBe(true);
    expect(link).toHaveBeenCalledWith(expect.objectContaining({
      include: [{ 'media.class': 'Stream/Output/Audio', 'application.process.id': '1234' }],
      mute: false,
      only_default_speakers: false,
      exclude: expect.arrayContaining([{ 'application.process.id': '4100' }]),
    }));
    ctl.stop();
  });
});

describe('native PipeWire applications without a process ID', () => {
  it('lists a Haruna-style stream by serial and captures only that stream', () => {
    const list = vi.fn(() => [{ 'object.serial': '393173', 'application.name': 'haruna', 'node.name': 'haruna', 'media.class': 'Stream/Output/Audio' }]);
    const link = vi.fn(() => true);
    class Bay {
      static hasPipeWire() { return true; }
      list = list; link = link; unlink = vi.fn();
    }
    const ctl = createSystemAudioController({ platform: 'linux', loadModule: () => ({ PatchBay: Bay }), getPids: () => [1], executablePath: '/app/Backspace' });
    expect(ctl.targets()).toEqual([{ id: 'node:393173', name: 'haruna' }]);
    expect(ctl.start('node:393173').ok).toBe(true);
    expect(link).toHaveBeenCalledWith(expect.objectContaining({ include: [{ 'media.class': 'Stream/Output/Audio', 'object.serial': '393173' }] }));
    ctl.stop();
  });
});
