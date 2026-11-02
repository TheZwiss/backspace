import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined), options: [] as Array<{ x: number; y: number; focusable: boolean }>, navigate: vi.fn(), destroyed: vi.fn() }));
vi.mock('electron', () => ({
 screen: { getPrimaryDisplay: () => ({ workArea: { x: -1920, y: -100, width: 1920, height: 1080 } }) },
 BrowserWindow: class {
  webContents = { on: mocks.navigate, executeJavaScript: vi.fn().mockResolvedValue(undefined) };
  constructor(options: { x: number; y: number; focusable: boolean }) { mocks.options.push(options); }
  on = vi.fn(); setAlwaysOnTop = vi.fn(); setIgnoreMouseEvents = vi.fn(); showInactive = vi.fn(); setOpacity = vi.fn();
  loadURL = mocks.load; isDestroyed = () => false; destroy = mocks.destroyed;
 },
}));
import { showFriendRequestToast, dismissFriendRequestToast } from './friendRequestToast';
const notice = { requestId: 'r', origin: '', userId: 'alice', sender: '<Bob>', labels: { body: 'Wants to add you.', accept: 'Accept', decline: 'Decline', close: 'Close' } };
afterEach(() => { dismissFriendRequestToast(notice); vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); mocks.options.length = 0; });
describe('desktop friend request card', () => {
 it('appears at the top-right without focus and sends icon actions separately', async () => {
  vi.useFakeTimers(); const action = vi.fn();
  await showFriendRequestToast(notice, action);
  expect(mocks.options[0]).toMatchObject({ x: -384, y: -88, focusable: false });
  const html = decodeURIComponent(mocks.load.mock.calls[0]![0].split(',').slice(1).join(','));
  expect(html).toContain('&lt;Bob&gt;'); expect(html).toContain('data-action="accepted"'); expect(html).not.toContain('>Accept</button>');
  const navigate = mocks.navigate.mock.calls[0]![1] as (event: { preventDefault: () => void }, url: string) => void;
  navigate({ preventDefault: vi.fn() }, 'https://backspace-friend.invalid/accepted');
  expect(action).toHaveBeenCalledWith('accepted'); expect(action).not.toHaveBeenCalledWith('open');
 });
});
