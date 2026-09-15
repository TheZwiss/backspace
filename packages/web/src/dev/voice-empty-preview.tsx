// Dev-only workbench for the empty voice channel (scene bible row 1). Nothing in
// the app imports this file; `dev-voice-empty.html` is its only entry. It shows
// the panel at the widths it ships at, under the real channel header, on the
// real chat surface, so the scene can be judged as a user sees it.
// `?state=hover` forces the Join button's hover state for a screenshot.
import type { ReactNode } from 'react';
import { VoiceEmptyPanel } from '../components/voice/VoiceEmptyPanel';
import { WorkbenchPage, Section } from './workbench';
import { mountScenePage } from './harness';

/** The main column as MainContent renders it around the panel: header, then the panel filling the rest. */
function MainColumn({ width, height, name, children }: { width: number; height: number; name: string; children: ReactNode }) {
  return (
    <div style={{ width, height, display: 'flex', flexDirection: 'column', background: 'rgb(var(--bg-base))', borderRadius: 8, overflow: 'hidden', boxShadow: '0 0 0 1px rgb(var(--border-hard))' }}>
      <div className="h-14 px-5 flex items-center justify-between border-b border-border-hard flex-shrink-0 bg-surface-base">
        <div className="flex items-center gap-[10px]">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
            <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" />
          </svg>
          <span className="font-bold text-[15px] tracking-[-0.02em] text-txt-primary">{name}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

function Workbench() {
  const noop = () => undefined;
  return (
    <WorkbenchPage
      title="Empty voice channel — design workbench"
      description="The panel a voice channel shows before anyone is in it, under its real header, at three widths the app actually gives it. Add ?state=hover to the URL to force the Join button's hover state."
    >
      <Section title="Shipping size: a 1440px window with both sidebars open (1000 × 760)">
        <MainColumn width={1000} height={760} name="counter-strike">
          <VoiceEmptyPanel channelName="counter-strike" onJoin={noop} />
        </MainColumn>
      </Section>
      <Section title="Narrow: a 900px window (560 × 560)">
        <MainColumn width={560} height={560} name="the-long-way">
          <VoiceEmptyPanel channelName="the-long-way" onJoin={noop} />
        </MainColumn>
      </Section>
      <Section title="Wide: a 2560px window with the member list closed (1320 × 900)">
        <MainColumn width={1320} height={900} name="real-homies">
          <VoiceEmptyPanel channelName="real-homies" onJoin={noop} />
        </MainColumn>
      </Section>
      <Section title="A long name">
        <MainColumn width={720} height={480} name="great-wall-of-china-and-the-long-way-round">
          <VoiceEmptyPanel channelName="great-wall-of-china-and-the-long-way-round" onJoin={noop} />
        </MainColumn>
      </Section>
    </WorkbenchPage>
  );
}

void mountScenePage(<Workbench />);
