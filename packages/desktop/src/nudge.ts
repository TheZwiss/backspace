import { BrowserWindow, desktopCapturer, screen } from 'electron';
import { showNudgeToast } from './nudgeToast';
import { buildNudgeAnimation } from './nudgeEffects';
import type { NudgeEffect } from './nudgeEffects';
import { getMsnKnockVideo } from './msnKnockAsset';
import { isMsnWinkEffect } from './msnWinkCatalog';
import { playMsnWink } from './msnWinks';
import type { NudgePresentation } from './nudgePresentation';

let active = false;
let lastPlayed = 0;

/**
 * True inside a Wayland desktop session, even when the app itself runs through
 * XWayland: the X server only draws X11 clients, so a screen capture taken from
 * inside the app comes back (mostly) black there. XDG_SESSION_TYPE is rewritten
 * to x11 for the capture backend, hence WAYLAND_DISPLAY is the reliable signal.
 */
function isWaylandSession(): boolean {
  return process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
}

/** Capture before creating overlays, so the overlays never capture themselves. */
export async function playNudge(sender = 'Alguém', avatar?: string, onOpen?: () => void, effect: NudgeEffect = 'shake', mode = 'full', presentation: NudgePresentation = {}): Promise<void> {
  // The shake/pulse effect animates a screenshot of the desktop. Wayland offers no
  // silent screenshot (the portal opens a picker, XWayland captures black), so the
  // notification alone is shown there. Winks do not capture the screen.
  if (mode !== 'notification' && !(mode === 'full' && isMsnWinkEffect(effect)) && isWaylandSession()) {
    mode = 'notification';
  }
  if (active || Date.now() - lastPlayed < 10_000) return;
  active = true;
  lastPlayed = Date.now();
  if (mode === 'full' && isMsnWinkEffect(effect)) {
    try { await playMsnWink(effect, sender, avatar, onOpen, presentation); } finally { active = false; }
    return;
  }
  if (mode === 'notification') {
    try { await showNudgeToast(sender, avatar, onOpen, effect, true, presentation); } finally { active = false; }
    return;
  }
  const overlays: BrowserWindow[] = [];
  let cancelled = false;
  const close = () => overlays.forEach(w => { if (!w.isDestroyed()) w.destroy(); });
  const abort = () => { cancelled = true; close(); };
  const watchdog = setTimeout(abort, 5000);
  screen.on('display-added', abort);
  screen.on('display-removed', abort);
  screen.on('display-metrics-changed', abort);
  try {
    const displays = screen.getAllDisplays().filter(d => !presentation.displayIds || presentation.displayIds.includes(d.id));
    if (!displays.length) return;
    const primaryId = displays.some(d => d.id === screen.getPrimaryDisplay().id) ? screen.getPrimaryDisplay().id : displays[0]!.id;
    const knockVideo = effect === 'knock' && mode === 'full' ? getMsnKnockVideo() : null;
    let sources: Electron.DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
        width: Math.max(...displays.map(d => Math.ceil(d.size.width * d.scaleFactor))),
        height: Math.max(...displays.map(d => Math.ceil(d.size.height * d.scaleFactor))),
      } });
    } catch (error) {
      // No screen capture (portal refused, no X server...): the notice still has to arrive.
      console.warn('[Nudge] Screen capture unavailable, showing the notification only.', error);
      if (!cancelled) await showNudgeToast(sender, avatar, onOpen, effect, true, presentation);
      return;
    }
    if (cancelled) return;
    await Promise.all(displays.map(async display => {
      const source = sources.find(s => s.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('Display capture unavailable');
      const window = new BrowserWindow({ ...display.bounds, show: false, frame: false,
        thickFrame: false, backgroundColor: '#000000', opacity: 0,
        focusable: false, skipTaskbar: true, resizable: false, movable: false,
        enableLargerThanScreen: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
      overlays.push(window);
      window.setIgnoreMouseEvents(true);
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setBounds(display.bounds);
      // Windows constrains ordinary borderless windows to the work area.
      // Fullscreen covers the taskbar while retaining this display's bounds.
      window.setFullScreen(true);
      window.moveTop();
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}img{width:100%;height:100%;will-change:transform;object-fit:fill}video{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:326px;height:260px;max-width:80vw;object-fit:contain;visibility:hidden}</style><img ${display.id === primaryId ? 'data-sound' : ''} src="${source.thumbnail.toDataURL()}">${knockVideo ? `<video preload="auto" ${display.id !== primaryId || presentation.sound === false ? 'muted' : ''} src="${knockVideo}"></video>` : ''}`));
    }));
    if (cancelled || overlays.some(w => w.isDestroyed())) return;
    // Prepare the compositor while invisible, including fullscreen's first paint.
    // Reveal all monitors only after every image has decoded and painted.
    overlays.forEach(w => w.showInactive());
    await Promise.all(overlays.map(w => w.webContents.executeJavaScript(`(async()=>{
      await document.images[0].decode();
      const video=document.querySelector('video');
      if(video&&video.readyState<2)await new Promise((resolve,reject)=>{video.addEventListener('loadeddata',resolve,{once:true});video.addEventListener('error',reject,{once:true})});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    })()`)));
    if (cancelled || overlays.some(w => w.isDestroyed())) return;
    const start = Date.now() + 150;
    const positions = [[0, 0], [-5, 2], [5, -2], [-4, -3], [5, 2], [-5, 1], [4, -2],
      [-4, 3], [5, -1], [-4, -2], [3, 2], [-3, -1], [2, 1], [-1, -1], [0, 0]];
    const keyframes = Array.from({ length: 5 }, () => positions).flat()
      .map(([x, y]) => ({ transform: `translate3d(${x}px,${y}px,0)` }));
    overlays.forEach(w => { w.setOpacity(1); w.moveTop(); });
    void showNudgeToast(sender, avatar, () => { abort(); onOpen?.(); }, effect, !knockVideo, presentation);
    await Promise.all(overlays.map(w => w.webContents.executeJavaScript(buildNudgeAnimation(mode === 'reduced' ? 'pulse' : effect, start, keyframes, presentation.volume ?? .6))));
  } catch (error) {
    if (!cancelled) throw error;
  } finally {
    close();
    clearTimeout(watchdog);
    screen.removeListener('display-added', abort);
    screen.removeListener('display-removed', abort);
    screen.removeListener('display-metrics-changed', abort);
    active = false;
  }
}
