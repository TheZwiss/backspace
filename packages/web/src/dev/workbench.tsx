// The shared frame for design workbench pages. Nothing in the app imports this
// file; the `dev-*.html` entries beside index.html are its only consumers.
//
// A workbench page renders one component at its real shipping size inside the
// real surrounding surface, again at 3x for detail work, and in every state a
// static screenshot needs to show. Hover, focus and press are forced by the
// classes .is-hover, .is-focus and .is-active on an ancestor; every material
// and scene stylesheet writes its state rules twice so those classes work.
import type { CSSProperties, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/globals.css';

const captionStyle: CSSProperties = { fontSize: 11, color: 'rgb(var(--text-tertiary))', letterSpacing: '0.02em' };

export function WorkbenchPage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: 'calc(100 * var(--app-vh))',
        background: 'rgb(var(--bg-chat))',
        padding: 40,
        display: 'flex',
        flexDirection: 'column',
        gap: 56,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h1 style={{ fontSize: 16, fontWeight: 600, color: 'rgb(var(--text-primary))' }}>{title}</h1>
        <p style={{ fontSize: 12, color: 'rgb(var(--text-secondary))', maxWidth: 620 }}>{description}</p>
      </div>
      {children}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h2 style={{ fontSize: 12, fontWeight: 600, color: 'rgb(var(--text-secondary))', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * One captioned slot. `width` and `height` are the component's real layout
 * size; `scale` blows it up for detail work without changing that size, so a
 * 3x slot shows exactly the pixels the 1x slot ships.
 */
export function Slot({
  caption,
  className = '',
  scale = 1,
  width,
  height,
  children,
}: {
  caption: string;
  className?: string;
  scale?: number;
  width: number;
  height: number;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={captionStyle}>{caption}</span>
      <div style={{ width: width * scale, height: height * scale }}>
        <div className={className} style={{ width, height, transform: `scale(${scale})`, transformOrigin: 'top left', display: 'flex' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** The four states a static screenshot has to show, side by side, at one size. */
export function StateRow({ width, height, render }: { width: number; height: number; render: (disabled: boolean) => ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <Slot caption="rest" width={width} height={height}>{render(false)}</Slot>
      <Slot caption="hover (.is-hover)" className="is-hover" width={width} height={height}>{render(false)}</Slot>
      <Slot caption="focus (.is-focus)" className="is-focus" width={width} height={height}>{render(false)}</Slot>
      <Slot caption="pressed (.is-active)" className="is-active" width={width} height={height}>{render(false)}</Slot>
      <Slot caption="disabled" width={width} height={height}>{render(true)}</Slot>
    </div>
  );
}

const surroundBackground: Record<'base' | 'chat' | 'channel' | 'modal', CSSProperties> = {
  base: { background: 'rgb(var(--bg-base))' },
  chat: { background: 'rgb(var(--bg-chat))' },
  channel: { background: 'rgb(var(--bg-channel))' },
  modal: {},
};

/**
 * The real surface a component ships on. `modal` renders the glass panel
 * itself so modal content and modal chrome can be judged together.
 */
export function Surround({
  kind,
  width,
  padding = 24,
  children,
}: {
  kind: 'base' | 'chat' | 'channel' | 'modal';
  width: number;
  padding?: number;
  children: ReactNode;
}) {
  if (kind === 'modal') {
    return (
      <div className="glass-modal" style={{ borderRadius: 16, padding, width }}>
        {children}
      </div>
    );
  }
  return (
    <div style={{ ...surroundBackground[kind], borderRadius: 8, padding, width }}>
      {children}
    </div>
  );
}

export function mountWorkbench(node: ReactNode) {
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(node);
}
