import { useEffect, useRef } from 'react';
import type { MascotState } from '../components/ui/Mascot';

const EASING = {
  gentle: 'cubic-bezier(0.4, 0, 0.2, 1)',
  softOut: 'cubic-bezier(0, 0, 0.2, 1)',
  bounce: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  breathe: 'cubic-bezier(0.45, 0.05, 0.55, 0.95)',
} as const;

export function useMascotAnimation(
  svgRef: React.RefObject<SVGSVGElement | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  state: MascotState,
): void {
  interface Cancellable { cancel(): void }
  const timeoutRef = useRef<number | null>(null);
  const activeAnimations = useRef<Cancellable[]>([]);
  const abortedRef = useRef(false);

  useEffect(() => {
    abortedRef.current = false;
    activeAnimations.current = [];

    // Check reduced motion preference
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (mq?.matches) return;

    const svgEl = svgRef.current;
    if (!svgEl || !svgEl.animate) return;
    // Capture as non-null for use in closures (TypeScript doesn't narrow refs across closures)
    const svg: SVGSVGElement = svgEl;

    // ── Helpers ──

    function rand(a: number, b: number): number {
      return a + Math.random() * (b - a);
    }

    function queryEl<T extends Element>(selector: string): T | null {
      return svgRef.current?.querySelector<T>(selector) ?? null;
    }

    function queryContainer<T extends Element>(selector: string): T | null {
      return containerRef.current?.querySelector<T>(selector) ?? null;
    }

    function animate(
      el: Element,
      keyframes: Keyframe[],
      options: KeyframeAnimationOptions,
    ): Animation | null {
      if (!el.animate) return null;
      const anim = el.animate(keyframes, options);
      activeAnimations.current.push(anim);
      return anim;
    }

    async function waitAnim(anim: Animation | null): Promise<void> {
      if (!anim || abortedRef.current) return;
      try {
        await anim.finished;
      } catch {
        // Animation was cancelled — safe to ignore
      }
    }

    function wait(ms: number): Promise<void> {
      return new Promise((resolve) => {
        if (abortedRef.current) {
          resolve();
          return;
        }
        const id = window.setTimeout(resolve, ms);
        // Store so cleanup can cancel if needed — but we use abortedRef as the primary guard
        timeoutRef.current = id;
      });
    }

    function scheduleNext(
      fn: () => Promise<void>,
      minMs: number,
      maxMs: number,
    ): void {
      if (abortedRef.current) return;
      if (timeoutRef.current != null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      const delay = rand(minMs, maxMs);
      timeoutRef.current = window.setTimeout(() => {
        if (abortedRef.current) return;
        fn().then(() => {
          if (!abortedRef.current) {
            scheduleNext(fn, minMs, maxMs);
          }
        }).catch(() => {
          // Action failed — reschedule unless aborted
          if (!abortedRef.current) {
            scheduleNext(fn, minMs, maxMs);
          }
        });
      }, delay);
    }

    // ── Shared animation actions ──

    /**
     * Animate an SVG element's ry attribute with a scaleY fallback for Safari.
     * Returns the Animation or null.
     */
    function animateEyeRy(
      el: Element,
      fromRy: number,
      toRy: number,
      options: KeyframeAnimationOptions,
    ): Animation | null {
      // Try ry animation first (works in Chrome/Firefox)
      const anim = animate(
        el,
        [{ ry: `${fromRy}px` }, { ry: `${toRy}px` }],
        options,
      );
      if (anim && anim.playState === 'running') {
        return anim;
      }
      // Safari fallback: use scaleY from the center of the ellipse
      if (anim) {
        try { anim.cancel(); } catch { /* ignore */ }
      }
      const ratio = toRy / (fromRy || 1);
      const cy = el.getAttribute('cy') ?? '0';
      return animate(
        el,
        [
          { transform: 'scaleY(1)', transformOrigin: `center ${cy}px` },
          { transform: `scaleY(${ratio})`, transformOrigin: `center ${cy}px` },
        ],
        options,
      );
    }

    async function droopyBlink(opts?: {
      closeDur?: number;
      openDur?: number;
      stagger?: number;
      holdClosed?: number;
    }): Promise<void> {
      if (abortedRef.current) return;

      const closeDur = opts?.closeDur ?? 200;
      const openDur = opts?.openDur ?? 320;
      const stagger = opts?.stagger ?? 120;
      const holdClosed = opts?.holdClosed ?? 80;

      const lw = queryEl<SVGEllipseElement>('[data-eye="white"][data-side="left"]');
      const rw = queryEl<SVGEllipseElement>('[data-eye="white"][data-side="right"]');
      const lp = queryEl<SVGEllipseElement>('[data-eye="pupil"][data-side="left"]');
      const rp = queryEl<SVGEllipseElement>('[data-eye="pupil"][data-side="right"]');

      if (!lw || !rw || !lp || !rp) return;

      const lwRy = parseFloat(lw.getAttribute('ry') ?? '13');
      const rwRy = parseFloat(rw.getAttribute('ry') ?? '13');
      const lpRy = parseFloat(lp.getAttribute('ry') ?? '8');
      const rpRy = parseFloat(rp.getAttribute('ry') ?? '8');

      // Close left eye first
      animateEyeRy(lw, lwRy, 1, { duration: closeDur, easing: EASING.gentle, fill: 'forwards' });
      animateEyeRy(lp, lpRy, 0.5, { duration: closeDur, easing: EASING.gentle, fill: 'forwards' });

      await wait(stagger);
      if (abortedRef.current) return;

      // Right follows
      animateEyeRy(rw, rwRy, 1, { duration: closeDur, easing: EASING.gentle, fill: 'forwards' });
      animateEyeRy(rp, rpRy, 0.5, { duration: closeDur, easing: EASING.gentle, fill: 'forwards' });

      await wait(closeDur + holdClosed);
      if (abortedRef.current) return;

      // Both open together
      animateEyeRy(lw, 1, lwRy, { duration: openDur, easing: EASING.softOut, fill: 'forwards' });
      animateEyeRy(lp, 0.5, lpRy, { duration: openDur, easing: EASING.softOut, fill: 'forwards' });
      animateEyeRy(rw, 1, rwRy, { duration: openDur, easing: EASING.softOut, fill: 'forwards' });
      const lastOpen = animateEyeRy(rp, 0.5, rpRy, { duration: openDur, easing: EASING.softOut, fill: 'forwards' });

      await waitAnim(lastOpen);
    }

    function lookPupils(dx: number, dy: number, dur = 500): Animation | null {
      const lp = queryEl<SVGEllipseElement>('[data-eye="pupil"][data-side="left"]');
      const rp = queryEl<SVGEllipseElement>('[data-eye="pupil"][data-side="right"]');
      if (!lp || !rp) return null;

      animate(lp, [{ transform: `translate(${dx}px, ${dy}px)` }], {
        duration: dur,
        easing: EASING.gentle,
        fill: 'forwards',
      });
      return animate(rp, [{ transform: `translate(${dx}px, ${dy}px)` }], {
        duration: dur,
        easing: EASING.gentle,
        fill: 'forwards',
      });
    }

    // ── Float & shadow helpers ──

    function startFloat(
      el: Element,
      amp: number,
      period: number,
    ): Animation | null {
      return animate(el, [
        { transform: `translateY(${amp * 0.6}px)` },
        { transform: `translateY(${-amp}px)` },
        { transform: `translateY(${amp * 0.6}px)` },
      ], { duration: period, easing: EASING.gentle, iterations: Infinity });
    }

    function startShadowPulse(
      shadow: Element,
      baseRx: number,
      minRx: number,
      baseOpacity: number,
      minOpacity: number,
      period: number,
    ): Animation | null {
      return animate(shadow, [
        { rx: baseRx, opacity: baseOpacity },
        { rx: minRx, opacity: minOpacity },
        { rx: baseRx, opacity: baseOpacity },
      ], { duration: period, easing: EASING.gentle, iterations: Infinity });
    }

    // ── Pause all SVG animations and restart float+shadow ──

    function pauseAllSvgAnimations(): void {
      const currentSvg = svgRef.current;
      if (!currentSvg) return;
      // getAnimations may not exist in all contexts
      if (typeof currentSvg.getAnimations === 'function') {
        currentSvg.getAnimations().forEach((a) => {
          try { a.pause(); } catch { /* ignore */ }
        });
      }
    }

    function restartFloatAndShadow(
      amp: number,
      period: number,
      shadowBaseRx: number,
      shadowMinRx: number,
      shadowBaseOpacity: number,
      shadowMinOpacity: number,
    ): void {
      const currentSvg = svgRef.current;
      if (!currentSvg) return;
      startFloat(currentSvg, amp, period);
      const shadow = queryEl('[data-mascot="shadow"]');
      if (shadow) {
        startShadowPulse(shadow, shadowBaseRx, shadowMinRx, shadowBaseOpacity, shadowMinOpacity, period);
      }
    }

    // ═══ IDLE STATE ═══

    function setupIdle(): void {
      // Start floating
      startFloat(svg, 5, 4200);

      // Shadow pulse
      const shadow = queryEl('[data-mascot="shadow"]');
      if (shadow) {
        startShadowPulse(shadow, 32, 25, 0.13, 0.06, 4200);
      }

      async function blink(): Promise<void> {
        await droopyBlink();
      }

      async function doubleBlink(): Promise<void> {
        await droopyBlink({ stagger: 80 });
        await wait(200);
        if (abortedRef.current) return;
        await droopyBlink({ stagger: 150 });
      }

      async function lookAround(): Promise<void> {
        if (abortedRef.current) return;
        const side = Math.random() > 0.5 ? 1 : -1;
        await waitAnim(lookPupils(3 * side, -1, 500));
        if (abortedRef.current) return;
        await wait(rand(800, 1800));
        if (abortedRef.current) return;
        await waitAnim(lookPupils(-3 * side, 0.5, 600));
        if (abortedRef.current) return;
        await wait(rand(600, 1400));
        if (abortedRef.current) return;
        await waitAnim(lookPupils(0, 0, 450));
      }

      async function wiggle(): Promise<void> {
        if (abortedRef.current) return;
        pauseAllSvgAnimations();

        const currentSvg = svgRef.current;
        if (!currentSvg) return;

        const wiggleAnim = animate(currentSvg, [
          { transform: 'translateY(0) rotate(0deg)' },
          { transform: 'translateY(-5px) rotate(-4deg)' },
          { transform: 'translateY(-2px) rotate(3deg)' },
          { transform: 'translateY(-4px) rotate(-2deg)' },
          { transform: 'translateY(0) rotate(0deg)' },
        ], { duration: 900, easing: EASING.bounce });
        await waitAnim(wiggleAnim);

        if (abortedRef.current) return;
        restartFloatAndShadow(5, 4200, 32, 25, 0.13, 0.06);
      }

      const actions = [blink, blink, blink, blink, doubleBlink, lookAround, wiggle] as const;

      async function runRandomAction(): Promise<void> {
        if (abortedRef.current) return;
        const action = actions[Math.floor(Math.random() * actions.length)];
        if (action) await action();
      }

      scheduleNext(runRandomAction, 2500, 7000);
    }

    // ═══ SLEEPING STATE ═══

    function setupSleeping(): void {
      // Breathing animation on SVG
      animate(svg, [
        { transform: 'scaleX(1) scaleY(1)' },
        { transform: 'scaleX(1.015) scaleY(0.975)' },
        { transform: 'scaleX(1) scaleY(1)' },
      ], { duration: 3800, easing: EASING.breathe, iterations: Infinity });

      // Mouth breathing animation
      const mouth = queryEl('[data-mascot="mouth"]');
      if (mouth) {
        animate(mouth, [
          { ry: '3.2px' },
          { ry: '4px' },
          { ry: '3.2px' },
        ], { duration: 3800, easing: EASING.breathe, iterations: Infinity });
      }

      // Z-particle spawning
      async function spawnZ(): Promise<void> {
        if (abortedRef.current) return;
        const zContainer = queryContainer<HTMLDivElement>('[data-mascot="z-container"]');
        if (!zContainer) return;

        const z = document.createElement('span');
        z.textContent = 'z';
        z.style.position = 'absolute';
        z.style.bottom = '25px';
        z.style.left = `${8 + Math.random() * 15}px`;
        z.style.fontSize = `${12 + Math.random() * 7}px`;
        z.style.fontWeight = '700';
        z.style.fontStyle = 'italic';
        z.style.color = '#c4b5e0';
        z.style.opacity = '0';
        z.style.pointerEvents = 'none';

        zContainer.appendChild(z);

        const rot = rand(-15, 15);
        const zAnim = animate(z, [
          { opacity: 0, transform: 'translateY(0) rotate(0deg) scale(0.5)' },
          { opacity: 0.5, transform: `translateY(-12px) rotate(${rot * 0.3}deg) scale(0.95)`, offset: 0.25 },
          { opacity: 0.35, transform: `translateY(-35px) rotate(${rot * 0.7}deg) scale(1)`, offset: 0.65 },
          { opacity: 0, transform: `translateY(-55px) rotate(${rot}deg) scale(0.85)` },
        ], { duration: 3200, easing: EASING.softOut });

        await waitAnim(zAnim);

        // Remove the z element if still in DOM
        if (z.parentNode) {
          z.remove();
        }
      }

      scheduleNext(spawnZ, 3500, 6500);
    }

    // ═══ EXCITED STATE ═══

    function setupExcited(): void {
      // Start floating
      startFloat(svg, 4, 4400);

      // Shadow pulse
      const shadow = queryEl('[data-mascot="shadow"]');
      if (shadow) {
        startShadowPulse(shadow, 32, 25, 0.13, 0.06, 4400);
      }

      async function blink(): Promise<void> {
        await droopyBlink();
      }

      async function excitedGreeting(): Promise<void> {
        if (abortedRef.current) return;
        const currentSvg = svgRef.current;
        if (!currentSvg) return;

        // Stop float
        pauseAllSvgAnimations();

        // 1. Anticipation — slight crouch
        const anticipation = animate(currentSvg, [
          { transform: 'translateY(0) scaleX(1) scaleY(1)' },
          { transform: 'translateY(4px) scaleX(1.06) scaleY(0.92)' },
        ], { duration: 200, easing: EASING.gentle, fill: 'forwards' });
        await waitAnim(anticipation);
        if (abortedRef.current) return;

        // 2. Hop up! — stretch tall, squish narrow
        const hop = animate(currentSvg, [
          { transform: 'translateY(4px) scaleX(1.06) scaleY(0.92)' },
          { transform: 'translateY(-18px) scaleX(0.92) scaleY(1.08)' },
        ], { duration: 250, easing: EASING.bounce, fill: 'forwards' });
        await waitAnim(hop);
        if (abortedRef.current) return;

        // 3. Land — squish on impact
        const land = animate(currentSvg, [
          { transform: 'translateY(-18px) scaleX(0.92) scaleY(1.08)' },
          { transform: 'translateY(3px) scaleX(1.08) scaleY(0.93)' },
        ], { duration: 200, easing: EASING.gentle, fill: 'forwards' });
        await waitAnim(land);
        if (abortedRef.current) return;

        // 4. Settle with a happy wiggle
        const settle = animate(currentSvg, [
          { transform: 'translateY(3px) scaleX(1.08) scaleY(0.93) rotate(0deg)' },
          { transform: 'translateY(-2px) scaleX(1) scaleY(1) rotate(-5deg)' },
          { transform: 'translateY(0) scaleX(1) scaleY(1) rotate(4deg)' },
          { transform: 'translateY(-1px) scaleX(1) scaleY(1) rotate(-3deg)' },
          { transform: 'translateY(0) scaleX(1) scaleY(1) rotate(0deg)' },
        ], { duration: 700, easing: EASING.gentle, fill: 'forwards' });
        await waitAnim(settle);

        if (abortedRef.current) return;
        // Resume float
        restartFloatAndShadow(4, 4400, 32, 25, 0.13, 0.06);
      }

      // Initial greeting fires once after 1500ms
      const initialTimeout = window.setTimeout(async () => {
        if (abortedRef.current) return;
        await excitedGreeting();
        if (abortedRef.current) return;

        // Then start the random action loop
        const actions = [blink, blink, blink, blink, excitedGreeting] as const;

        async function runRandomAction(): Promise<void> {
          if (abortedRef.current) return;
          const action = actions[Math.floor(Math.random() * actions.length)];
          if (action) await action();
        }

        scheduleNext(runRandomAction, 5000, 14000);
      }, 1500);

      // Store initial timeout so cleanup can cancel it
      activeAnimations.current.push({
        cancel: () => clearTimeout(initialTimeout),
      });
    }

    // ═══ LONELY STATE ═══

    function setupLonely(): void {
      // Slow melancholy sway
      animate(svg, [
        { transform: 'translateY(0) rotate(0deg)' },
        { transform: 'translateY(2px) rotate(-1.5deg)' },
        { transform: 'translateY(0) rotate(0deg)' },
        { transform: 'translateY(2px) rotate(1.5deg)' },
        { transform: 'translateY(0) rotate(0deg)' },
      ], { duration: 6000, easing: EASING.gentle, iterations: Infinity });

      async function lonelyBlink(): Promise<void> {
        await droopyBlink({
          closeDur: 250,
          openDur: 400,
          stagger: 160,
          holdClosed: 120,
        });
      }

      async function lookDown(): Promise<void> {
        if (abortedRef.current) return;
        await waitAnim(lookPupils(-1, 3, 700));
        if (abortedRef.current) return;
        await wait(rand(2000, 4000));
        if (abortedRef.current) return;
        await waitAnim(lookPupils(0, 0, 600));
      }

      async function sigh(): Promise<void> {
        if (abortedRef.current) return;
        const container = containerRef.current;
        if (!container) return;

        const b = document.createElement('div');
        b.setAttribute('data-mascot-particle', '');
        b.style.position = 'absolute';
        b.style.top = '42%';
        b.style.right = '22px';
        b.style.width = '5px';
        b.style.height = '5px';
        b.style.borderRadius = '50%';
        b.style.background = 'rgba(120,174,200,0.3)';
        b.style.pointerEvents = 'none';

        container.appendChild(b);

        const sighAnim = animate(b, [
          { opacity: 0, transform: 'scale(0) translateY(0)' },
          { opacity: 0.5, transform: 'scale(1) translateY(-4px)', offset: 0.15 },
          { opacity: 0.3, transform: 'scale(1.2) translateY(-22px)', offset: 0.6 },
          { opacity: 0, transform: 'scale(0.7) translateY(-40px)' },
        ], { duration: 2800, easing: EASING.softOut });

        await waitAnim(sighAnim);

        // Remove bubble if still in DOM
        if (b.parentNode) {
          b.remove();
        }
      }

      const actions = [lonelyBlink, lonelyBlink, lonelyBlink, lookDown, sigh] as const;

      async function runRandomAction(): Promise<void> {
        if (abortedRef.current) return;
        const action = actions[Math.floor(Math.random() * actions.length)];
        if (action) await action();
      }

      scheduleNext(runRandomAction, 3500, 9000);
    }

    // ── Dispatch to the appropriate state setup ──

    switch (state) {
      case 'idle':
        setupIdle();
        break;
      case 'sleeping':
        setupSleeping();
        break;
      case 'excited':
        setupExcited();
        break;
      case 'lonely':
        setupLonely();
        break;
    }

    // ── Reduced motion runtime toggle ──
    function handleMotionChange(e: MediaQueryListEvent): void {
      if (e.matches) {
        // User enabled reduced motion — cancel everything
        abortedRef.current = true;
        if (timeoutRef.current != null) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        activeAnimations.current.forEach((a) => {
          try { a.cancel(); } catch { /* ignore */ }
        });
        activeAnimations.current = [];
      }
    }

    if (mq) {
      mq.addEventListener('change', handleMotionChange);
    }

    // ── Cleanup ──
    return () => {
      abortedRef.current = true;

      if (timeoutRef.current != null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      // Cancel all active animations
      activeAnimations.current.forEach((a) => {
        try { a.cancel(); } catch { /* ignore */ }
      });
      activeAnimations.current = [];

      // Remove spawned z-particles
      const zContainer = containerRef.current?.querySelector('[data-mascot="z-container"]');
      if (zContainer) {
        zContainer.innerHTML = '';
      }

      // Remove sigh bubble particles
      containerRef.current?.querySelectorAll('[data-mascot-particle]').forEach((el) => el.remove());

      // Remove reduced motion listener
      if (mq) {
        mq.removeEventListener('change', handleMotionChange);
      }
    };
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
}
