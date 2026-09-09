// Dev-only workbench for the friends page on glass over the living home
// backdrop (scene bible section 13). Nothing in the app imports this file;
// `dev-friends-home.html` is its only entry. Two replicas of the friends main
// column at its shipping size: one with an empty tab, one with rows, so both
// the backdrop and the legibility of names on the glass panel can be judged.
// The header, the panel and the backdrop are the real components.
import { useState, type ReactNode } from 'react';
import { CrewEmptyState } from '../components/ui/CrewEmptyState';
import { FriendsHeader, FriendsPanel } from '../components/chat/FriendsGlass';
import { HomeSpace } from '../components/chat/HomeSpace';
import { Avatar } from '../components/ui/Avatar';
import { WorkbenchPage, Section } from './workbench';
import { mountScenePage } from './harness';

const ROWS: ReadonlyArray<{ name: string; colour: string; status: string }> = [
  { name: 'Mara', colour: 'mint', status: 'Online' },
  { name: 'Tobin', colour: 'peach', status: 'Idle' },
  { name: 'Isa', colour: 'lavender', status: 'Online' },
  { name: 'Ren', colour: 'sky', status: 'Do not disturb' },
  { name: 'Ola', colour: 'amber', status: 'Online' },
];

function Column({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  return (
    <div style={{ width, height, borderRadius: 8, overflow: 'hidden', boxShadow: '0 0 0 1px rgb(var(--border-hard))' }}>
      <div className="flex-1 flex flex-col bg-surface-chat h-full relative">
        <HomeSpace />
        {children}
      </div>
    </div>
  );
}

function Header({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  return (
    <FriendsHeader
      title="Friends"
      tabs={[
        { id: 'online', label: 'Online', active: active === 'online', onSelect: () => onSelect('online') },
        { id: 'all', label: 'All', active: active === 'all', onSelect: () => onSelect('all') },
        { id: 'pending', label: 'Pending', active: active === 'pending', badge: 2, onSelect: () => onSelect('pending') },
      ]}
      addLabel="Add Friend"
      addActive={active === 'add'}
      onAdd={() => onSelect('add')}
      trailing={
        <button type="button" className="w-8 h-8 flex items-center justify-center text-txt-tertiary rounded-[6px]" title="Toggle Member List">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" /></svg>
        </button>
      }
    />
  );
}

function Rows() {
  return (
    <div className="flex-1 overflow-y-auto p-4">
      <h2 className="friends-count text-xs font-bold text-txt-tertiary mb-4 tracking-wider px-2">ONLINE — {ROWS.length}</h2>
      {ROWS.map((row, i) => (
        <div key={row.name} className="friends-row flex items-center justify-between px-3 h-[62px] rounded-[8px] hover:bg-interactive-hover group transition-colors mx-2">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar name={row.name} size={36} avatarColor={row.colour} userId={`u${i}`} />
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-txt-primary">{row.name}</div>
              <div className="text-[13px] text-txt-tertiary">{row.status}</div>
            </div>
          </div>
          <div className="flex items-center gap-1 text-txt-tertiary">
            <span className="w-8 h-8 flex items-center justify-center rounded-full bg-interactive-hover">…</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Workbench() {
  const [active, setActive] = useState('online');
  return (
    <WorkbenchPage
      title="Friends on glass — design workbench"
      description="The friends main column at its shipping size: the living home backdrop, glass pills for the controls, each friend row its own bubble, the count its own pill, and Nori on the backdrop when nobody is there. Tabs are live; the backdrop must not change when they switch."
    >
      <Section title="Empty tab and a tab with rows (1000 × 760)">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <Column width={1000} height={760}>
            <Header active={active} onSelect={setActive} />
            <FriendsPanel>
              <div className="flex-1 overflow-y-auto p-4">
                <h2 className="friends-count text-xs font-bold text-txt-tertiary mb-4 tracking-wider px-2">ONLINE — 0</h2>
                <div style={{ height: 'calc(100% - 32px)' }}>
                  <CrewEmptyState variant="nobodyOnline" size="hero">No one's online right now.</CrewEmptyState>
                </div>
              </div>
            </FriendsPanel>
          </Column>
          <Column width={1000} height={760}>
            <Header active="all" onSelect={() => undefined} />
            <FriendsPanel>
              <Rows />
            </FriendsPanel>
          </Column>
        </div>
      </Section>
      <Section title="Narrow column (600 × 560)">
        <Column width={600} height={560}>
          <Header active="pending" onSelect={() => undefined} />
          <FriendsPanel>
            <div className="flex-1 overflow-y-auto p-4">
              <h2 className="friends-count text-xs font-bold text-txt-tertiary mb-4 tracking-wider px-2">PENDING — 0</h2>
              <div style={{ height: 'calc(100% - 32px)' }}>
                <CrewEmptyState variant="noPending" size="hero">No pending requests — Nori is napping.</CrewEmptyState>
              </div>
            </div>
          </FriendsPanel>
        </Column>
      </Section>
    </WorkbenchPage>
  );
}

void mountScenePage(<Workbench />);
