// Dev-only workbench for the material tier. Nothing in the app imports this
// file; `dev-material.html` is its only entry. It shows every material class on
// the surfaces that ship it: the primary call to action at its real sizes and
// states, a modal with its chrome and scrim over a chat surface, the three
// toasts, and the five layers stacked on a bare card so each can be judged.
import type { ReactNode } from 'react';
import { WorkbenchPage, Section, Slot, StateRow, Surround, mountWorkbench } from './workbench';

function Cta({ disabled, className, children }: { disabled: boolean; className: string; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} className={`cta-primary ${className}`} onClick={() => undefined}>
      {children}
    </button>
  );
}

function ModalSample({ scrim }: { scrim: boolean }) {
  return (
    <div style={{ position: 'relative', width: 560, height: 360, borderRadius: 8, overflow: 'hidden', background: 'rgb(var(--bg-chat))' }}>
      {/* A stand-in for the chat behind the modal, so the scrim has something to darken. */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
        <div style={{ width: 72, background: 'rgb(var(--bg-base))' }} />
        <div style={{ width: 160, background: 'rgb(var(--bg-channel))' }} />
        <div style={{ flex: 1, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[0.9, 0.6, 0.75, 0.5].map((w, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ width: 28, height: 28, borderRadius: 14, background: 'rgb(var(--accent-lavender) / 0.4)' }} />
              <div style={{ height: 10, width: `${w * 60}%`, borderRadius: 5, background: 'rgb(var(--text-tertiary) / 0.5)' }} />
            </div>
          ))}
        </div>
      </div>
      <div className={scrim ? 'modal-scrim' : ''} style={{ position: 'absolute', inset: 0, background: scrim ? undefined : 'rgb(0 0 0 / 0.5)' }} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="glass-modal" style={{ borderRadius: 8, width: 320, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: 'rgb(var(--text-primary))' }}>Create Channel</span>
            <span style={{ color: 'rgb(var(--text-tertiary))' }}>×</span>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'rgb(var(--text-secondary))', textTransform: 'uppercase' }}>Channel name</span>
          <input className="input-standard w-full" placeholder="new-channel" readOnly />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 13, color: 'rgb(var(--text-secondary))', padding: '6px 12px' }}>Cancel</span>
            <Cta disabled={false} className="px-3 py-1.5 text-sm rounded-full">Create Channel</Cta>
          </div>
        </div>
      </div>
    </div>
  );
}

function Toast({ kind, children }: { kind: 'info' | 'success' | 'warning'; children: ReactNode }) {
  return (
    <div className={`glass-pill toast-lit toast-lit--${kind} rounded-[10px] px-4 py-2.5 max-w-[320px] flex items-center gap-3`}>
      <span className="flex-1 text-sm text-txt-primary leading-snug">{children}</span>
    </div>
  );
}

/** The five material layers on a bare panel, so each one can be judged alone and together. */
function LayerCard({ layers, label }: { layers: ReadonlyArray<'aura' | 'scrim' | 'gloss' | 'sheen' | 'rim'>; label: string }) {
  const has = (l: string) => layers.includes(l as (typeof layers)[number]);
  return (
    <div className="mat-host" style={{ width: 176, height: 42, borderRadius: 12, overflow: 'visible', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {has('aura') && <span className="mat-aura" aria-hidden="true" />}
      <span style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', overflow: 'hidden', background: 'linear-gradient(152deg, rgb(var(--bg-elevated)) 0%, rgb(var(--bg-chat)) 48%, rgb(var(--bg-base)) 100%)' }}>
        {has('scrim') && <span className="mat-scrim" aria-hidden="true" />}
        {has('gloss') && <span className="mat-gloss" aria-hidden="true" />}
        {has('sheen') && <span className="mat-sheen" aria-hidden="true" />}
        {has('rim') && <span className="mat-rim" aria-hidden="true" />}
      </span>
      <span style={{ position: 'relative', fontSize: 13, fontWeight: 600, color: 'rgb(var(--text-primary))', textShadow: '0 1px 3px rgb(var(--bg-base) / 0.75)' }}>{label}</span>
    </div>
  );
}

function Workbench() {
  return (
    <WorkbenchPage
      title="Material tier — design workbench"
      description="The reusable half of the soul pass: the primary call to action, modal chrome and scrim, lit toasts, and the five layers on their own. Hover, focus and press are forced by class so a screenshot can show them."
    >
      <Section title="Primary call to action, shipping sizes">
        <StateRow width={176} height={44} render={(d) => <Cta disabled={d} className="w-full py-2.5 rounded">Log In</Cta>} />
        <StateRow width={140} height={48} render={(d) => <Cta disabled={d} className="px-8 py-3 rounded-full text-[15px]">Join Voice</Cta>} />
        <StateRow width={128} height={30} render={(d) => <Cta disabled={d} className="px-3 py-1.5 text-sm rounded-full">Create Space</Cta>} />
      </Section>

      <Section title="Destructive and warning confirms: the derelict's cold rim">
        <StateRow width={190} height={40} render={(d) => <button type="button" disabled={d} className="cta-danger flex-1 py-2.5 text-sm rounded-lg">Delete Space</button>} />
        <StateRow width={190} height={40} render={(d) => <button type="button" disabled={d} className="cta-warning flex-1 py-2.5 text-sm rounded-lg">Leave Group</button>} />
      </Section>

      <Section title="Primary call to action at 3x">
        <div style={{ display: 'flex', gap: 48 }}>
          <Slot caption="rest" width={176} height={44} scale={3}><Cta disabled={false} className="w-full py-2.5 rounded">Log In</Cta></Slot>
          <Slot caption="hover" className="is-hover" width={176} height={44} scale={3}><Cta disabled={false} className="w-full py-2.5 rounded">Log In</Cta></Slot>
        </div>
      </Section>

      <Section title="Modal chrome and scrim">
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <Slot caption="before: flat 50% black, uniform border" width={560} height={360}><ModalSample scrim={false} /></Slot>
          <Slot caption="after: vignette scrim, turning rim, gloss" width={560} height={360}><ModalSample scrim /></Slot>
        </div>
      </Section>

      <Section title="Lit toasts">
        <Surround kind="chat" width={400}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
            <Toast kind="success">Invite link copied</Toast>
            <Toast kind="info">Reconnecting to the remote instance…</Toast>
            <Toast kind="warning">Failed to update registration settings</Toast>
          </div>
        </Surround>
        <div style={{ display: 'flex', gap: 48 }}>
          <Slot caption="success at 3x" width={220} height={40} scale={3}><Toast kind="success">Invite link copied</Toast></Slot>
        </div>
      </Section>

      <Section title="The five layers, one at a time, then stacked">
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <Slot caption="rim" width={176} height={42}><LayerCard layers={['rim']} label="rim" /></Slot>
          <Slot caption="gloss" width={176} height={42}><LayerCard layers={['gloss']} label="gloss" /></Slot>
          <Slot caption="scrim" width={176} height={42}><LayerCard layers={['scrim']} label="scrim" /></Slot>
          <Slot caption="aura (hover)" className="is-hover" width={176} height={42}><LayerCard layers={['aura']} label="aura" /></Slot>
          <Slot caption="sheen (hover)" className="is-hover" width={176} height={42}><LayerCard layers={['sheen']} label="sheen" /></Slot>
        </div>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <Slot caption="all, rest" width={176} height={42}><LayerCard layers={['aura', 'scrim', 'gloss', 'sheen', 'rim']} label="material" /></Slot>
          <Slot caption="all, hover" className="is-hover" width={176} height={42}><LayerCard layers={['aura', 'scrim', 'gloss', 'sheen', 'rim']} label="material" /></Slot>
          <Slot caption="all, 3x" width={176} height={42} scale={3}><LayerCard layers={['aura', 'scrim', 'gloss', 'sheen', 'rim']} label="material" /></Slot>
        </div>
      </Section>
    </WorkbenchPage>
  );
}

mountWorkbench(<Workbench />);
