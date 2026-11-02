import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined) }));
vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }), getAllDisplays: () => [] },
  BrowserWindow: class {
    webContents = { on: vi.fn(), executeJavaScript: vi.fn().mockResolvedValue(undefined) };
    setIgnoreMouseEvents = vi.fn(); setAlwaysOnTop = vi.fn(); setOpacity = vi.fn(); showInactive = vi.fn(); destroy = vi.fn();
    isDestroyed = () => false;
    loadURL = mocks.load;
  },
}));
import { showNudgeToast } from './nudgeToast';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); mocks.load.mockClear(); });
describe('native attention notification appearance', () => {
  it('embeds the app font and safely renders localized labels', async () => {
    vi.useFakeTimers();
    await showNudgeToast('<Alice>', undefined, undefined, 'shake', false, { labels: { notice: 'Chamou atenção <b>', close: 'Fechar "aviso"' } });
    const url = mocks.load.mock.calls[0]?.[0];
    expect(url).toBeDefined();
    const html = decodeURIComponent(url!.split(',').slice(1).join(','));
    expect(html).toContain('font-family:DM Sans');
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).toContain('&lt;Alice&gt;');
    expect(html).toContain('Chamou atenção &lt;b&gt;');
    expect(html).toContain('Fechar &quot;aviso&quot;');
    expect(html).not.toContain('<p>Chamou atenção <b>');
  });
});
