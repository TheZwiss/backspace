import type { NudgeEffect } from '@backspace/shared';
import type { NudgePlan } from './nudgePolicy';

let activeUntil = 0;

function playTone(volume: number): void {
  try {
    const context = new AudioContext();
    [660, 880, 660, 990].forEach((frequency, i) => {
      const oscillator = context.createOscillator(), gain = context.createGain(), time = context.currentTime + i * .11;
      oscillator.type = 'triangle'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(volume * .2, time); gain.gain.exponentialRampToValueAtTime(.001, time + .09);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(time); oscillator.stop(time + .1);
    });
    setTimeout(() => { void context.close(); }, 750);
  } catch { /* A blocked audio context never prevents the notice. */ }
}

export async function playInAppNudge(sender: string, avatar: string | undefined, channelId: string, effect: NudgeEffect, plan: NudgePlan): Promise<void> {
  if (Date.now() < activeUntil) return;
  activeUntil = Date.now() + 10_000;
  const movieEffect = effect === 'knock' || effect.startsWith('msn_');
  const media = movieEffect ? await window.backspace?.getNudgeMedia?.(effect).catch(() => null) : null;
  const animations: Animation[] = [];
  const layers: HTMLElement[] = [];
  const finishEffect = () => { animations.forEach(a => a.cancel()); layers.forEach(layer => layer.remove()); };
  const notice = document.createElement('div');
  notice.setAttribute('role', 'status');
  Object.assign(notice.style, { position: 'fixed', right: '16px', top: 'calc(var(--titlebar-inset, 0px) + 16px)',
    zIndex: '900', display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', maxWidth: '320px',
    background: 'rgb(var(--bg-elevated, 37 37 48))', color: 'rgb(var(--txt-primary, 238 238 243))',
    border: '1px solid rgb(var(--border-soft, 42 42 54))', borderLeft: '2px solid rgb(var(--accent-primary, 124 108 246))',
    borderRadius: '10px', boxShadow: '0 4px 16px #0004', cursor: 'pointer', font: '13px system-ui' });
  const face = document.createElement('span');
  Object.assign(face.style, { width: '36px', height: '36px', borderRadius: '50%', overflow: 'hidden', flex: 'none',
    display: 'grid', placeItems: 'center', background: '#7c6cf633', color: '#c4b5fd' });
  face.textContent = sender.charAt(0).toUpperCase();
  if (avatar) { const image = document.createElement('img'); image.src = avatar; Object.assign(image.style, { width: '36px', height: '36px', objectFit: 'cover' }); face.replaceChildren(image); }
  const text = document.createElement('div');
  const title = document.createElement('strong'); title.textContent = sender;
  Object.assign(title.style, { display: 'block', maxWidth: '205px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
  const description = document.createElement('p'); description.textContent = 'Chamou sua atenção!'; description.style.margin = '3px 0 0';
  text.append(title, description);
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Fechar notificação');
  Object.assign(close.style, { color: 'inherit', background: 'transparent', border: '0', width: '24px', height: '24px', cursor: 'pointer', fontSize: '20px' });
  close.onclick = event => { event.stopPropagation(); notice.remove(); };
  notice.onclick = () => { finishEffect(); notice.remove(); history.pushState({}, '', `/channels/@me/${channelId}`); dispatchEvent(new PopStateEvent('popstate')); };
  notice.append(face, text, close); document.body.append(notice);
  setTimeout(() => notice.remove(), 6000);
  if (plan.sound && media && (plan.mode !== 'full')) { const audio = new Audio(media.video); audio.volume = plan.volume; void audio.play().catch(() => {}); setTimeout(() => { audio.pause(); audio.removeAttribute('src'); }, media.durationMs + 500); }
  else if (plan.sound && !media) playTone(plan.volume);
  if (plan.mode === 'notification') return;
  const root = document.getElementById('root') ?? document.body;
  const layer = () => {
    const element = document.createElement('div');
    Object.assign(element.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '899', overflow: 'hidden' });
    document.body.append(element); layers.push(element); return element;
  };
  const animate = (element: HTMLElement, keyframes: Keyframe[]) => animations.push(element.animate(keyframes, { duration: 2000, easing: 'linear' }));
  let duration = 2000;
  if (plan.mode === 'reduced' || effect === 'pulse') {
    const border = layer(); border.style.border = '3px solid #7c6cf6'; border.style.boxShadow = 'inset 0 0 24px #7c6cf655';
    animate(border, [{ opacity: 0 }, { opacity: .8 }, { opacity: .15 }, { opacity: .6 }, { opacity: 0 }]);
  } else if (media) {
    const host = layer(), video = document.createElement('video');
    video.src = media.video; video.muted = !plan.sound; video.volume = plan.volume; video.playsInline = true;
    Object.assign(video.style, { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', maxWidth: '80%', maxHeight: '80%' });
    host.append(video); duration = media.durationMs;
    void video.play().catch(() => host.remove());
    setTimeout(() => { video.pause(); video.removeAttribute('src'); }, duration + 100);
  } else if (movieEffect) {
    // Older clients and browsers can still display the notice without leaking outside the app.
    return;
  } else if (effect === 'confetti') {
    const host = layer();
    for (let i = 0; i < 40; i++) {
      const particle = document.createElement('span');
      Object.assign(particle.style, { position: 'absolute', right: '100px', top: '60px', width: '6px', height: '10px', background: ['#7c6cf6', '#86efac', '#fca5a5', '#fcd34d'][i % 4] });
      host.append(particle); const angle = i * 2.39996, distance = 80 + i % 7 * 22;
      animate(particle, [{ transform: 'translate(0,0)', opacity: 0 }, { offset: .08, opacity: 1 }, { transform: `translate(${Math.cos(angle) * distance}px,${Math.sin(angle) * distance + 160}px) rotate(${i * 47}deg)`, opacity: 0 }]);
    }
  } else if (effect === 'jelly') {
    animate(root, [{ scale: '1' }, { scale: '1.008 .992' }, { scale: '.994 1.006' }, { scale: '1.004 .996' }, { scale: '1' }]);
  } else if (effect === 'wave') {
    animate(root, Array.from({ length: 61 }, (_, i) => ({ translate: `0 ${Math.sin(i / 60 * Math.PI * 6) * Math.sin(i / 60 * Math.PI) * 4}px` })));
  } else {
    animate(root, Array.from({ length: 75 }, (_, i) => ({ translate: `${i === 0 || i === 74 ? 0 : i % 2 ? -5 : 5}px ${i % 3 - 1}px` })));
  }
  setTimeout(finishEffect, duration + 100);
}
