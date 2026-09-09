// Dev-only workbench for the crew quarters (scene bible row 3): every "no one
// is here" state in one place. Nothing in the app imports this file;
// `dev-crew-empty.html` is its only entry. Hero variants sit in a replica of
// the friends page column; compact variants in a replica of the DM sidebar and
// the mobile lists.
import type { ReactNode } from 'react';
import { CrewEmptyState, type CrewEmptyVariant } from '../components/ui/CrewEmptyState';
import { WorkbenchPage, Section } from './workbench';
import { mountScenePage } from './harness';

const COPY: Record<CrewEmptyVariant, string> = {
  nobodyOnline: "No one's online right now.",
  noFriends: 'No friends yet — add someone!',
  noPending: 'No pending requests — Nori is napping.',
  noActivity: "It's quiet for now... When friends start an activity, we'll show it here!",
  noDms: 'No conversations yet',
  noSpaces: 'No channels yet',
};

/** The friends page column as FriendsPage lays it out: header strip, section label, then the empty state filling the rest. */
function FriendsColumn({ width, height, label, children }: { width: number; height: number; label: string; children: ReactNode }) {
  return (
    <div style={{ width, height, display: 'flex', flexDirection: 'column', background: 'rgb(var(--bg-chat))', borderRadius: 8, overflow: 'hidden', boxShadow: '0 0 0 1px rgb(var(--border-hard))' }}>
      <div className="h-14 px-5 flex items-center border-b border-border-hard flex-shrink-0">
        <span className="font-bold text-[15px] text-txt-primary">Friends</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <h2 className="text-xs font-bold text-txt-tertiary mb-4 tracking-wider px-2">{label}</h2>
        <div style={{ height: 'calc(100% - 32px)' }}>{children}</div>
      </div>
    </div>
  );
}

/** The DM sidebar column as ChannelSidebar lays it out. */
function SidebarColumn({ children }: { children: ReactNode }) {
  return (
    <div style={{ width: 312, height: 420, display: 'flex', flexDirection: 'column', background: 'rgb(var(--bg-channel))', borderRadius: 8, overflow: 'hidden', boxShadow: '0 0 0 1px rgb(var(--border-hard))' }}>
      <div className="px-3 pt-3 pb-2">
        <div className="input-search w-full">Find or start a conversation</div>
      </div>
      <div className="px-3 pt-4 text-xs font-bold text-txt-tertiary tracking-wider">Direct Messages</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Workbench() {
  return (
    <WorkbenchPage
      title="Crew quarters — design workbench"
      description="Every reason a list of people can be empty, as one scene with six beats. Hero variants fill the friends page column at 128px; compact variants sit in the DM sidebar and the mobile lists at 80px."
    >
      <Section title="Hero: the friends page column (1000 × 700, and 560 × 560)">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <FriendsColumn width={1000} height={700} label="ONLINE — 0">
            <CrewEmptyState variant="nobodyOnline" size="hero">{COPY.nobodyOnline}</CrewEmptyState>
          </FriendsColumn>
          <FriendsColumn width={560} height={560} label="ALL FRIENDS — 0">
            <CrewEmptyState variant="noFriends" size="hero">{COPY.noFriends}</CrewEmptyState>
          </FriendsColumn>
        </div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <FriendsColumn width={560} height={560} label="PENDING — 0">
            <CrewEmptyState variant="noPending" size="hero">{COPY.noPending}</CrewEmptyState>
          </FriendsColumn>
          <FriendsColumn width={390} height={640} label="ACTIVITY">
            <CrewEmptyState variant="noActivity" size="hero">{COPY.noActivity}</CrewEmptyState>
          </FriendsColumn>
        </div>
      </Section>
      <Section title="Compact: the DM sidebar and the mobile lists">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <SidebarColumn>
            <CrewEmptyState variant="noDms" size="compact">{COPY.noDms}</CrewEmptyState>
          </SidebarColumn>
          <SidebarColumn>
            <CrewEmptyState variant="noSpaces" size="compact">{COPY.noSpaces}</CrewEmptyState>
          </SidebarColumn>
        </div>
      </Section>
    </WorkbenchPage>
  );
}

void mountScenePage(<Workbench />);
