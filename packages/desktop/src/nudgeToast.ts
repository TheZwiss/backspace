import { getIconMotionScript } from './iconMotion';
import { nudgeVisualTheme as theme, getNudgeFont } from './nudgeVisualTheme';
import { BrowserWindow, screen } from 'electron';
import { getMsnKnockVideo } from './msnKnockAsset';
import { getMsnWinkAsset, isMsnWinkEffect } from './msnWinkCatalog';
import type { NudgePresentation } from './nudgePresentation';

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export async function showNudgeToast(sender: string, avatar?: string, onOpen?: () => void, effect = 'shake', playSound = true, presentation: NudgePresentation = {}): Promise<void> {
  const primary = screen.getPrimaryDisplay();
  const display = presentation.displayIds ? (presentation.displayIds.includes(primary.id) ? primary
    : screen.getAllDisplays().find(d => presentation.displayIds!.includes(d.id))) : primary;
  if (!display) return;
  const { bounds } = display;
  const width = Math.min(320, bounds.width);
  const window = new BrowserWindow({ x: bounds.x + bounds.width - width - 16, y: bounds.y + 16,
    width, height: 88, frame: false, transparent: true, backgroundColor: '#00000000',
    show: false, opacity: 0, focusable: false, skipTaskbar: true, resizable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  const close = () => { if (!window.isDestroyed()) window.destroy(); };
  const watchdog = setTimeout(close, 10_000);
  try {
    window.setIgnoreMouseEvents(false);
    window.setAlwaysOnTop(true, 'screen-saver');
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === 'https://backspace-nudge.invalid/open') {
        close();
        onOpen?.();
      }
    });
    const photo = avatar && avatar.length < 1_500_000 && /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(avatar)
      ? `<img src="${avatar}" alt="">` : '';
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><style>@font-face{font-family:DM Sans;src:url(data:font/woff2;base64,${getNudgeFont()}) format('woff2');font-weight:100 1000}*{box-sizing:border-box}html,body{margin:0;background:transparent;font:13px ${theme.fontFamily};color:${theme.foreground}}article{cursor:pointer;margin:4px;padding:12px;display:flex;align-items:center;gap:10px;border:1px solid ${theme.border};border-left:2px solid ${theme.accent};border-radius:${theme.radius}px;background:${theme.surface};box-shadow:0 2px 8px #0003}.avatar{position:relative;flex:none;width:36px;height:36px;display:grid;place-items:center;border-radius:50%;overflow:hidden;background:${theme.accent}22;color:${theme.foreground};font-weight:600;font-size:16px}.avatar img{position:absolute;width:100%;height:100%;object-fit:cover}strong{display:block;max-width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:600}p{margin:3px 0 0;color:${theme.muted};font-size:12px}button{margin-left:auto;align-self:flex-start;flex:none;width:32px;height:32px;border:0;border-radius:6px;background:transparent;color:${theme.muted};font:20px ${theme.fontFamily};cursor:pointer}button:hover{background:#ffffff14;color:#fff}</style><article role="status" data-icon-motion="bell"><span class="avatar" data-icon-motion-target>${escape(sender.charAt(0).toUpperCase())}${photo}</span><div><strong>${escape(sender.slice(0, 80))}</strong><p>${escape(presentation.labels?.notice ?? 'Nudge')}</p></div><button data-icon-motion="press" type="button" aria-label="${escape(presentation.labels?.close ?? 'Close')}" title="${escape(presentation.labels?.close ?? 'Close')}"><span data-icon-motion-target>×</span></button></article>`));
    if (window.isDestroyed()) return;
    window.showInactive();
      await window.webContents.executeJavaScript(getIconMotionScript());
    await window.webContents.executeJavaScript(`(async()=>{document.querySelector("button").addEventListener("click",event=>{event.stopPropagation();window.close()});document.querySelector("article").addEventListener("click",()=>{location.href="https://backspace-nudge.invalid/open"});await Promise.all([...document.images].map(i=>i.decode().catch(()=>i.remove())));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()`);
    if (window.isDestroyed()) return;
    window.setOpacity(1);
    window.moveTop();
    if (playSound && presentation.sound !== false && (effect === 'knock' || isMsnWinkEffect(effect))) {
      const media = effect === 'knock' ? getMsnKnockVideo() : getMsnWinkAsset(effect as import('./msnWinkCatalog').MsnWinkEffect).video;
      await window.webContents.executeJavaScript(`(()=>{const audio=new Audio(${JSON.stringify(media)});window.nudgeAudio=audio;audio.volume=${presentation.volume ?? .6};audio.play().catch(()=>{})})()`);
    } else if (playSound && presentation.sound !== false) await window.webContents.executeJavaScript(`(()=>{try{
      const context=new AudioContext();
      const knock=${effect === 'knock'};
      (knock?[180,150]:[660,880,660,990]).forEach((frequency,i)=>{
        const oscillator=context.createOscillator(),gain=context.createGain(),time=context.currentTime+i*(knock?.3:.11);
        oscillator.type=knock?'sine':'triangle';oscillator.frequency.value=frequency;
        gain.gain.setValueAtTime(${presentation.volume ?? .6}*.2,time);gain.gain.exponentialRampToValueAtTime(.001,time+.09);
        oscillator.connect(gain);gain.connect(context.destination);oscillator.start(time);oscillator.stop(time+.1);
      });setTimeout(()=>context.close(),750);
    }catch{}})()`);
    clearTimeout(watchdog);
    setTimeout(close, 6000);
  } catch {
    clearTimeout(watchdog);
    close();
  }
}
