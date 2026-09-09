// Dev-only workbench for the welcome hero (scene bible row 7). Nothing in the
// app imports this file; `dev-welcome-hero.html` is its only entry. The three
// kinds render inside a replica of the message list's scroll container, each
// with three short messages below so the join with the first message can be
// judged, plus a two-line title and a six-member group. Figures are static
// elements; the hero itself reads no store. The page prints each hero's
// rendered height under it, because that height is part of the scroll contract
// and must not change from what the old header measured.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { User } from '@backspace/shared';
import { WelcomeHero, type WelcomeHeroKind } from '../components/chat/WelcomeHero';
import { Avatar } from '../components/ui/Avatar';
import { AvatarStack } from '../components/ui/AvatarStack';
import { WorkbenchPage, Section } from './workbench';
import { mountScenePage } from './harness';

const HASH_PATH =
  'M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z';

function person(id: string, name: string, colour: string): User {
  return { id, homeUserId: id, username: name.toLowerCase(), displayName: name, createdAt: 0, isAdmin: false, avatarColor: colour, replicatedInstances: [] } as unknown as User;
}
const CREW = [
  person('u1', 'Mara', 'mint'),
  person('u2', 'Tobin', 'peach'),
  person('u3', 'Isa', 'lavender'),
  person('u4', 'Ren', 'sky'),
  person('u5', 'Ola', 'amber'),
  person('u6', 'Kip', 'rose'),
];

const HashDisc = (
  <div className="w-[68px] h-[68px] rounded-full bg-surface-elevated flex items-center justify-center text-white">
    <svg width="42" height="42" viewBox="0 0 24 24" fill="currentColor"><path d={HASH_PATH} /></svg>
  </div>
);

function Messages() {
  return (
    <div className="px-4 pb-4 flex flex-col gap-4">
      {([['Mara', 'first light in here. who else made it?', 'mint'], ['Tobin', 'here. window seat taken already?', 'peach'], ['Isa', 'saving you one', 'lavender']] as const).map(([who, text, colour], i) => (
        <div key={who} className="flex gap-3 items-start">
          <Avatar name={who} size={40} avatarColor={colour} userId={`u${i + 1}`} />
          <div>
            <div className="text-[15px] font-semibold text-txt-primary">{who}</div>
            <div className="text-[15px] text-txt-message">{text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The scroll container as MessageList renders it, with the measured height of the hero printed under the frame. */
function ListFrame({ width, height = 520, kind, figure, title, children }: { width: number; height?: number; kind: WelcomeHeroKind; figure: ReactNode; title: string; children: ReactNode }) {
  const heroRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = heroRef.current?.firstElementChild;
    if (el) setMeasured(Math.round(el.getBoundingClientRect().height * 100) / 100);
  }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ width, height, background: 'rgb(var(--bg-chat))', borderRadius: 8, overflow: 'auto', boxShadow: '0 0 0 1px rgb(var(--border-hard))' }} className="scrollbar-thin">
        <div ref={heroRef}>
          <WelcomeHero kind={kind} figure={figure} title={title}>{children}</WelcomeHero>
        </div>
        <Messages />
      </div>
      <span style={{ fontSize: 11, color: 'rgb(var(--text-tertiary))' }}>hero height: {measured ?? '…'}px</span>
    </div>
  );
}

function Workbench() {
  return (
    <WorkbenchPage
      title="Welcome hero — design workbench"
      description="The block at the top of a conversation's history, inside a replica of the message list's scroll container, with three messages under it. The printed height must not change from the baseline: it is part of the scroll contract."
    >
      <Section title="Text channel, 700 and 1200 wide">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <ListFrame width={700} kind="channel" figure={HashDisc} title="Welcome to the channel!">
            <p className="text-txt-secondary text-[16px] mt-2">This is the start of the conversation.</p>
          </ListFrame>
          <ListFrame width={1200} kind="channel" figure={HashDisc} title="Welcome to the channel!">
            <p className="text-txt-secondary text-[16px] mt-2">This is the start of the conversation.</p>
          </ListFrame>
        </div>
      </Section>
      <Section title="Direct message">
        <ListFrame width={700} kind="dm" figure={<Avatar name="Mara" size={80} avatarColor="mint" userId="u1" />} title="Mara">
          <p className="text-txt-secondary text-[14px] mt-1">This is the beginning of your direct message history with <strong>@Mara</strong>.</p>
          <div className="mt-4">
            <button type="button" className="px-4 py-1.5 bg-surface-elevated text-[14px] font-medium text-txt-primary rounded-[3px]">Remove Friend</button>
          </div>
        </ListFrame>
      </Section>
      <Section title="Group, six members, and a two-line title">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <ListFrame width={700} kind="group" figure={<AvatarStack members={CREW} size={80} border="chat" />} title="Night watch">
            <p className="text-txt-secondary text-[14px] mt-1">This is the beginning of your group conversation.</p>
            <p className="text-xs text-txt-tertiary mt-1">Owner: <strong>@Mara</strong></p>
            <div className="mt-4 flex items-center gap-2">
              <button type="button" className="px-4 py-1.5 bg-accent-primary text-white text-[14px] font-medium rounded-[3px]">Open Group Settings</button>
              <button type="button" className="px-4 py-1.5 bg-surface-elevated text-[14px] font-medium text-txt-primary rounded-[3px]">Leave Group</button>
            </div>
          </ListFrame>
          <ListFrame width={420} kind="channel" figure={HashDisc} title="Welcome to the channel that has a very long name indeed!">
            <p className="text-txt-secondary text-[16px] mt-2">This is the start of the conversation.</p>
          </ListFrame>
        </div>
      </Section>
    </WorkbenchPage>
  );
}

void mountScenePage(<Workbench />);
