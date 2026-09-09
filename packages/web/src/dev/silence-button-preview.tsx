// Dev-only workbench for the SilenceButton design pass. Nothing in the app imports
// this file; `dev-silence-button.html` is its only entry. It exists so the button
// can be iterated on and screenshotted on its own, at the size it ships at and
// blown up, without booting an instance.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SilenceButton } from '../components/telemetry/answers/SilenceButton';
import '../styles/globals.css';

const LABEL = 'Radio silence';

function Slot({ caption, className = '', scale = 1 }: { caption: string; className?: string; scale?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 11, color: 'rgb(var(--text-tertiary))' }}>{caption}</span>
      <div style={{ width: 176 * scale, transform: `scale(${scale})`, transformOrigin: 'top left', height: 44 }}>
        <div className={className} style={{ display: 'flex', width: 176 }}>
          <SilenceButton onClick={() => undefined}>{LABEL}</SilenceButton>
        </div>
      </div>
    </div>
  );
}

function Workbench() {
  const [disabled, setDisabled] = useState(false);
  return (
    <div style={{ minHeight: 'calc(100 * var(--app-vh))', background: 'rgb(var(--bg-chat))', padding: 40, display: 'flex', flexDirection: 'column', gap: 56 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h1 style={{ fontSize: 16, fontWeight: 600, color: 'rgb(var(--text-primary))' }}>Radio silence button — design workbench</h1>
        <p style={{ fontSize: 12, color: 'rgb(var(--text-secondary))', maxWidth: 620 }}>
          Top row is the shipping size inside the modal's glass. Below it, the same button at 3x for detail work.
        </p>
        <label style={{ fontSize: 12, color: 'rgb(var(--text-secondary))', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
          disabled (saving)
        </label>
      </div>

      {/* Shipping context: the modal's glass panel, two-button row, real widths. */}
      <div className="glass-modal" style={{ borderRadius: 16, padding: 24, maxWidth: 380 }}>
        <p style={{ fontSize: 13, color: 'rgb(var(--text-secondary))', marginBottom: 16 }}>
          Everything that comes back is published as open data on the project's insights page.
        </p>
        <div style={{ display: 'flex', gap: 12 }}>
          <SilenceButton disabled={disabled} onClick={() => undefined}>{LABEL}</SilenceButton>
          <div style={{ flex: 1, borderRadius: 8, border: '1px dashed rgba(255,255,255,0.10)', display: 'grid', placeItems: 'center', fontSize: 12, color: 'rgb(var(--text-tertiary))' }}>
            other answer
          </div>
        </div>
      </div>

      {/* States. Write hover and focus styles as `:hover, .is-hover &` and
          `:focus-visible, .is-focus &` so these two slots render them statically. */}
      <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
        <Slot caption="rest" />
        <Slot caption="hover (.is-hover)" className="is-hover" />
        <Slot caption="focus (.is-focus)" className="is-focus" />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={{ fontSize: 11, color: 'rgb(var(--text-tertiary))' }}>3x</span>
        <div style={{ height: 150 }}>
          <div style={{ display: 'flex', width: 176, transform: 'scale(3)', transformOrigin: 'top left' }}>
            <SilenceButton onClick={() => undefined}>{LABEL}</SilenceButton>
          </div>
        </div>
      </div>
    </div>
  );
}

const host = document.getElementById('root');
if (!host) throw new Error('missing #root');
createRoot(host).render(<Workbench />);
