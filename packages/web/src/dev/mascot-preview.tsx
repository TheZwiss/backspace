// Dev-only workbench for Nori, the mascot (scene bible row 12). Nothing in the
// app imports this file; `dev-mascot.html` is its only entry. It shows every
// mood at the sizes the app uses (128, 100, 80) on the two surfaces it sits on,
// and one mood at 3x for detail work. The animation hook runs as it does in the
// app; add --force-prefers-reduced-motion to the screenshot for the still frame.
import { Mascot, type MascotState } from '../components/ui/Mascot';
import { WorkbenchPage, Section, Slot, Surround } from './workbench';
import { mountScenePage } from './harness';

const MOODS: readonly MascotState[] = ['idle', 'lonely', 'sleeping', 'excited'];

function Workbench() {
  return (
    <WorkbenchPage
      title="Nori — design workbench"
      description="Four moods at the three sizes the app renders, on the chat surface and on the sidebar surface, then idle and sleeping at 3x. The hook animates as in the app."
    >
      <Section title="On the chat surface, 128px (friends page empty states)">
        <Surround kind="chat" width={720}>
          <div style={{ display: 'flex', gap: 40, alignItems: 'flex-end' }}>
            {MOODS.map((m) => (
              <div key={m} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <Mascot state={m} className="w-32 h-32" />
                <span style={{ fontSize: 11, color: 'rgb(var(--text-tertiary))' }}>{m}</span>
              </div>
            ))}
          </div>
        </Surround>
      </Section>
      <Section title="On the sidebar surface, 80px (DM list empty state)">
        <Surround kind="channel" width={520}>
          <div style={{ display: 'flex', gap: 32, alignItems: 'flex-end' }}>
            {MOODS.map((m) => (
              <Mascot key={m} state={m} className="w-20 h-20" />
            ))}
          </div>
        </Surround>
      </Section>
      <Section title="3x">
        <div style={{ display: 'flex', gap: 64 }}>
          <Slot caption="idle" width={128} height={128} scale={3}><Mascot state="idle" className="w-32 h-32" /></Slot>
          <Slot caption="sleeping" width={128} height={128} scale={3}><Mascot state="sleeping" className="w-32 h-32" /></Slot>
        </div>
      </Section>
    </WorkbenchPage>
  );
}

void mountScenePage(<Workbench />);
