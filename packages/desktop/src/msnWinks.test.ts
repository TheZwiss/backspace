import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMsnWinkAsset, isMsnWinkEffect, type MsnWinkEffect } from './msnWinkCatalog';
import { playMsnWink } from './msnWinks';

const mocks = vi.hoisted(() => ({ windows: [] as any[], capture: vi.fn(), displays: [
  { id: 1, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
  { id: 2, bounds: { x: 0, y: -200, width: 2560, height: 1440 } },
] }));
vi.mock('./nudgeToast', () => ({ showNudgeToast: vi.fn() }));
vi.mock('electron', () => ({
  desktopCapturer: { getSources: mocks.capture },
  screen: { getAllDisplays: () => mocks.displays, getPrimaryDisplay: () => mocks.displays[1], on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: class {
    options: unknown;
    destroyed = false;
    webContents = { executeJavaScript: vi.fn().mockResolvedValue(undefined) };
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    setFullScreen = vi.fn();
    bounds: unknown = {};
    setBounds = vi.fn((b: unknown) => { this.bounds = b; });
    getBounds() { return this.bounds; }
    setOpacity = vi.fn();
    moveTop = vi.fn();
    showInactive = vi.fn();
    loadURL = vi.fn().mockResolvedValue(undefined);
    constructor(options: unknown) { this.options = options; mocks.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  },
}));

const effects: MsnWinkEffect[] = ['msn_bouncy_ball', 'msn_bow', 'msn_dancing_pig', 'msn_eyeball', 'msn_frog', 'msn_guitar_smash', 'msn_heart', 'msn_kiss', 'msn_lipstick_girl', 'msn_love_letter', 'msn_notes', 'msn_silly_face', 'msn_stars', 'msn_water_balloon', 'msn_fart_guy'];
describe('additional original MSN winks', () => {
  beforeEach(() => { mocks.windows.length = 0; vi.clearAllMocks(); });
  it.each(effects)('%s plays transparently on all displays with one audio source and releases its windows', async effect => {
    expect(isMsnWinkEffect(effect)).toBe(true);
    const asset = getMsnWinkAsset(effect);
    expect(asset.video.startsWith('data:video/webm;base64,')).toBe(true);
    expect(asset.hasAudio).toBe(true);
    expect(asset.durationMs).toBeGreaterThan(2000);
    await playMsnWink(effect, 'Alice');
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.windows).toHaveLength(2);
    mocks.windows.forEach((w, i) => {
      expect(w.options).toMatchObject({ ...mocks.displays[i]!.bounds, transparent: true, focusable: false, opacity: 0 });
      expect(w.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
      if (process.platform === 'linux') expect(w.setFullScreen).not.toHaveBeenCalled(); else expect(w.setFullScreen).toHaveBeenCalledWith(true);
      expect(w.destroyed).toBe(true);
      const html = decodeURIComponent(w.loadURL.mock.calls[0][0]);
      expect(html.includes('<video preload="auto" muted')).toBe(i === 0);
    });
    expect(mocks.windows[0].webContents.executeJavaScript.mock.calls[1][0])
      .toBe(mocks.windows[1].webContents.executeJavaScript.mock.calls[1][0]);
  });
  it('rejects names outside the catalog', () => {
    expect(isMsnWinkEffect('../../secret')).toBe(false);
    expect(isMsnWinkEffect('toString')).toBe(false);
    expect(isMsnWinkEffect('knock')).toBe(false);
  });
  it('renders only on selected monitors and mutes the movie when requested', async () => {
    await playMsnWink('msn_fart_guy', 'Alice', undefined, undefined, { displayIds: [1], sound: false });
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].options).toMatchObject(mocks.displays[0]!.bounds);
    expect(decodeURIComponent(mocks.windows[0].loadURL.mock.calls[0][0])).toContain('<video preload="auto" muted');
  });
  it('does not fall back onto a removed or excluded monitor', async () => {
    await playMsnWink('msn_fart_guy', 'Alice', undefined, undefined, { displayIds: [999] });
    expect(mocks.windows).toHaveLength(0);
  });
});
