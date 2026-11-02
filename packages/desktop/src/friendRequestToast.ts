import { BrowserWindow, screen } from 'electron';
import { getNudgeFont, nudgeVisualTheme as theme } from './nudgeVisualTheme';
export interface FriendRequestToastData {
  requestId: string; origin: string; userId: string; sender: string; avatar?: string;
  labels: { body: string; accept: string; decline: string; close: string };
}
export type FriendRequestToastAction = 'open' | 'accepted' | 'declined' | 'dismiss';
const windows = new Map<string, { window: BrowserWindow; slot: number }>();
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const keyOf = (data: Pick<FriendRequestToastData, 'userId' | 'origin' | 'requestId'>) => JSON.stringify([data.userId, data.origin, data.requestId]);
export function dismissFriendRequestToast(data: Pick<FriendRequestToastData, 'userId' | 'origin' | 'requestId'>): void {
  const key = keyOf(data), entry = windows.get(key);
  if (entry && !entry.window.isDestroyed()) entry.window.destroy();
  windows.delete(key);
}
export async function showFriendRequestToast(data: FriendRequestToastData, onAction: (action: FriendRequestToastAction) => void): Promise<void> {
  const key = keyOf(data);
  if (windows.has(key)) return;
  if (windows.size >= 3) { const oldest = windows.keys().next().value; if (oldest) { const entry = windows.get(oldest)!; if (!entry.window.isDestroyed()) entry.window.destroy(); windows.delete(oldest); } }
  const occupied = new Set([...windows.values()].map(entry => entry.slot));
  const slot = [0, 1, 2].find(i => !occupied.has(i)) ?? 0;
  const bounds = screen.getPrimaryDisplay().workArea;
  const width = Math.min(372, bounds.width - 24);
  const window = new BrowserWindow({ x: bounds.x + bounds.width - width - 12, y: bounds.y + 12 + slot * 112, width, height: 108,
    frame: false, transparent: true, backgroundColor: '#00000000', show: false, opacity: 0, focusable: false, skipTaskbar: true, resizable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  windows.set(key, { window, slot });
  const close = () => { if (windows.get(key)?.window === window) windows.delete(key); if (!window.isDestroyed()) window.destroy(); };
  const timer = setTimeout(close, 12_000);
  window.on('closed', () => { clearTimeout(timer); if (windows.get(key)?.window === window) windows.delete(key); });
  try {
    window.setAlwaysOnTop(true, 'screen-saver'); window.setIgnoreMouseEvents(false);
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      const action = url.replace('https://backspace-friend.invalid/', '');
      if (!url.startsWith('https://backspace-friend.invalid/') || !['open', 'accepted', 'declined', 'close'].includes(action)) return;
      close(); onAction(action === 'close' ? 'dismiss' : action as FriendRequestToastAction);
    });
    const photo = data.avatar && data.avatar.length < 1_500_000 && /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(data.avatar) ? `<img src="${data.avatar}" alt="">` : '';
    const icon = (path: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="${path}"/></svg>`;
    const accept = escape(data.labels.accept), decline = escape(data.labels.decline), dismiss = escape(data.labels.close);
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><style>@font-face{font-family:DM Sans;src:url(data:font/woff2;base64,${getNudgeFont()}) format('woff2');font-weight:100 1000}*{box-sizing:border-box}body{margin:0;padding:4px;background:transparent;color:${theme.foreground};font:13px ${theme.fontFamily}}article{display:flex;align-items:center;gap:4px;padding:8px;border:1px solid ${theme.border};border-left:2px solid ${theme.accent};border-radius:${theme.radius}px;background:${theme.surface};box-shadow:0 2px 8px #0003;cursor:pointer}button{border:0;color:inherit;cursor:pointer;font:inherit;border-radius:6px;background:transparent}button:hover{background:#ffffff12}button:focus-visible{outline:2px solid ${theme.accent}}.main{display:flex;align-items:center;gap:8px;flex:1;min-width:0;text-align:left;padding:4px}.avatar{position:relative;width:36px;height:36px;flex:none;display:grid;place-items:center;border-radius:50%;overflow:hidden;background:${theme.accent}22}.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.text{flex:1;min-width:0}strong{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px}p{margin:3px 0 0;color:${theme.muted};font-size:12px;line-height:1.3}.action{display:grid;place-items:center;width:36px;height:36px;flex:none}.accept{color:#86efac;background:#86efac18}.decline{color:#fda4af;background:#fda4af18}.close{align-self:flex-start;width:20px;height:20px;color:${theme.muted};font-size:18px}</style><article><button class="main" data-action="open"><span class="avatar">${escape(data.sender.charAt(0).toUpperCase())}${photo}</span><span class="text"><strong>${escape(data.sender)}</strong><p>${escape(data.labels.body)}</p></span></button><button class="action accept" data-action="accepted" aria-label="${accept}" title="${accept}">${icon('m5 12 4 4L19 6')}</button><button class="action decline" data-action="declined" aria-label="${decline}" title="${decline}">${icon('m6 6 12 12M6 18 18 6')}</button><button class="close" data-action="close" aria-label="${dismiss}" title="${dismiss}">×</button></article>`;
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    if (window.isDestroyed()) return;
    window.showInactive();
    await window.webContents.executeJavaScript(`(async()=>{document.querySelector('article').addEventListener('click',event=>{const action=event.target.closest('[data-action]')?.dataset.action||'open';location.href='https://backspace-friend.invalid/'+action});await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
    if (!window.isDestroyed()) window.setOpacity(1);
  } catch { close(); }
}
