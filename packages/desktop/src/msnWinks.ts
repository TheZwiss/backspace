import { BrowserWindow, screen } from 'electron';
import { getMsnWinkAsset, type MsnWinkEffect } from './msnWinkCatalog';
import { showNudgeToast } from './nudgeToast';
import type { NudgePresentation } from './nudgePresentation';

export async function playMsnWink(effect: MsnWinkEffect, sender: string, avatar?: string, onOpen?: () => void, presentation: NudgePresentation = {}): Promise<void> {
  const asset = getMsnWinkAsset(effect);
  const windows: BrowserWindow[] = [];
  let cancelled = false;
  const close = () => { cancelled = true; windows.forEach(w => { if (!w.isDestroyed()) w.destroy(); }); };
  const watchdog = setTimeout(close, asset.durationMs + 8000);
  screen.on('display-added', close);
  screen.on('display-removed', close);
  screen.on('display-metrics-changed', close);
  try {
    const displays = screen.getAllDisplays().filter(d => !presentation.displayIds || presentation.displayIds.includes(d.id));
    if (!displays.length) return;
    const primary = displays.some(d => d.id === screen.getPrimaryDisplay().id) ? screen.getPrimaryDisplay().id : displays[0]!.id;
    await Promise.all(displays.map(async display => {
      const window = new BrowserWindow({ ...display.bounds, show: false, frame: false, thickFrame: false,
        transparent: true, backgroundColor: '#00000000', opacity: 0, focusable: false,
        skipTaskbar: true, resizable: false, movable: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
          backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
      windows.push(window);
      window.setIgnoreMouseEvents(true);
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setBounds(display.bounds);
      window.setFullScreen(true);
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;background:transparent;width:100%;height:100%;overflow:hidden}video{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:${asset.width}px;height:${asset.height}px;max-width:80vw;max-height:80vh;object-fit:contain;visibility:hidden}</style><video preload="auto" ${display.id !== primary || presentation.sound === false ? 'muted' : ''} src="${asset.video}"></video>`));
      if (cancelled || window.isDestroyed()) return;
      window.showInactive();
      await window.webContents.executeJavaScript(`(async()=>{const v=document.querySelector('video');if(v.readyState<2)await new Promise((r,j)=>{v.addEventListener('loadeddata',r,{once:true});v.addEventListener('error',j,{once:true})});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()`);
    }));
    if (cancelled) return;
    const start = Date.now() + 150;
    windows.forEach(w => { w.setOpacity(1); w.moveTop(); });
    void showNudgeToast(sender, avatar, () => { close(); onOpen?.(); }, effect, false, presentation);
    await Promise.all(windows.map(w => w.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const v=document.querySelector('video');setTimeout(()=>{v.style.visibility='visible';v.volume=${presentation.volume ?? .6};v.currentTime=Math.max(0,(Date.now()-${start})/1000);v.addEventListener('ended',resolve,{once:true});v.addEventListener('error',reject,{once:true});v.play().catch(reject)},Math.max(0,${start}-Date.now()))})`)));
  } catch (error) {
    if (!cancelled) throw error;
  } finally {
    close(); clearTimeout(watchdog);
    screen.removeListener('display-added', close);
    screen.removeListener('display-removed', close);
    screen.removeListener('display-metrics-changed', close);
  }
}
