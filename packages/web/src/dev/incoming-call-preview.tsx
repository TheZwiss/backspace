// Dev-only workbench for the incoming call modal (scene bible row 6). Nothing
// in the app imports this file; `dev-incoming-call.html` is its only entry. A
// live call cannot be surveyed, so the stores are seeded with one ringing call
// from an invented person and the real component renders over a stand-in for
// the chat behind it. `?state=hover` forces hover on the answer buttons.
import type { DmChannel, User } from '@backspace/shared';
import { IncomingCallModal } from '../components/voice/IncomingCallModal';
import { useSpaceStore } from '../stores/spaceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { mountScenePage } from './harness';

const CALLER = {
  id: 'u-caller',
  homeUserId: 'u-caller',
  username: 'mara',
  displayName: 'Mara',
  createdAt: 0,
  isAdmin: false,
  avatarColor: 'mint',
  replicatedInstances: [],
} as unknown as User;

const DM: DmChannel = {
  id: 'dm-workbench',
  createdAt: 0,
  members: [CALLER],
};

useSpaceStore.setState({ dmChannels: [DM] });
useVoiceStore.setState({ incomingCall: { dmChannelId: DM.id, callerId: CALLER.id, callerName: CALLER.username } });

/** A stand-in for the app behind the modal: strip, sidebar, a few message rows. */
function Behind() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'rgb(var(--bg-chat))' }}>
      <div style={{ width: 72, background: 'rgb(var(--bg-base))' }} />
      <div style={{ width: 240, background: 'rgb(var(--bg-channel))' }} />
      <div style={{ flex: 1, padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {[0.7, 0.45, 0.8, 0.3, 0.6, 0.5].map((w, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ width: 36, height: 36, borderRadius: 18, background: 'rgb(var(--accent-lavender) / 0.35)' }} />
            <div style={{ height: 12, width: `${w * 50}%`, borderRadius: 6, background: 'rgb(var(--text-tertiary) / 0.45)' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

void mountScenePage(
  <>
    <Behind />
    <IncomingCallModal />
  </>,
);
