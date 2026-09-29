// Dev-only workbench for the modal glass material (`.glass-modal`,
// docs/systems/design-system.md, "Nested glass"). Nothing in the app imports
// this file; `dev-glass-modals.html` is its only entry.
//
// Every scene is a real dialog over a busy page, so both layers of glass can
// be judged: the dialog blurring the page behind it, and a glass control
// inside the dialog (the Save/Discard pill, the Cancel/Join pill) blurring
// the dialog's own rows that scroll under it.
//
// `?scene=<name>`:
//   space-settings   Space Settings, Overview, the name edited so the
//                    Reset/Save pill is up; the panel scrolled under it.
//   create-space     Create Space: the Cancel/Create pill over the form.
//   join-space       Join Space: the Cancel/Join pill over the invite form.
//   transfer         Transfer Ownership: a positioned-by-utility dialog.
//   confirm          A plain confirm dialog.
// The channel permissions pill and the member role editor have their own
// harnesses (dev-permissions-editor.html?scene=long-edit,
// dev-member-roles.html?scene=editor-dirty).
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { MemberWithUser, Role, User } from '@backspace/shared';
import { SpaceSettingsModal } from '../components/modals/SpaceSettings';
import { CreateSpaceModal } from '../components/modals/CreateSpace';
import { JoinSpaceModal } from '../components/modals/JoinSpace';
import { TransferOwnershipModal } from '../components/modals/TransferOwnershipModal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { ALL_PERMISSIONS, permissionsToString } from '../utils/permissions';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene = 'space-settings' | 'create-space' | 'join-space' | 'transfer' | 'confirm';
const SCENES: readonly Scene[] = ['space-settings', 'create-space', 'join-space', 'transfer', 'confirm'];

const SPACE_ID = 'space-1';
const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender', ownerId: 'owner',
  inviteCode: 'aether', visibility: 'public', directoryListed: false,
  description: 'A calm place for night owls, synth music and long conversations.', createdAt: 1, _instanceOrigin: '',
};

function user(id: string, displayName: string): User {
  return {
    id, username: id, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null, bio: null,
    status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}
const EVERYONE: Role = { id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', color: '#b9bbbe', position: 0, permissions: '0', createdAt: 1 };
const MEMBERS: MemberWithUser[] = ['owner:Jannis', 'mira:Mira', 'kai:Kai', 'lena:Lena', 'tobi:Tobi', 'ada:Ada'].map((entry) => {
  const [id, name] = entry.split(':') as [string, string];
  return { spaceId: SPACE_ID, userId: id, nickname: null, joinedAt: 1, user: user(id, name), roles: [] };
});

/** Answers the few routes the dialogs read, so the harness needs no server. */
function stubFetch(): void {
  const realFetch = window.fetch.bind(window);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, window.location.href).pathname;
    if (path === `/api/spaces/${SPACE_ID}/members`) return json(MEMBERS);
    if (path.startsWith('/api/explore') || path.startsWith('/api/join-requests')) return json([]);
    if (path.startsWith('/api/')) return json({});
    return realFetch(input, init);
  };
}

/** A chat-like page behind the dialog, busy enough to show the dialog's blur. */
function Page() {
  const lines = [
    'Mira: the synth set tonight starts at nine, bring headphones',
    'Kai: I pushed the new cover art to #design, the lavender one',
    'Lena: can someone pin the rules message again?',
    'Tobi: 🎧 listening party in voice, all welcome',
    'Ada: moved the old threads into the archive category',
  ];
  return (
    <div className="fixed inset-0 bg-surface-chat overflow-hidden p-8 space-y-4">
      {Array.from({ length: 6 }, (_, block) => (
        <div key={block} className="space-y-2">
          {lines.map((line, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-full flex-shrink-0" style={{ background: ['#c4b5fd', '#a5f3c4', '#ffc9a9', '#93c5fd', '#fda4af'][i] }} />
              <span className="text-[15px] text-txt-primary">{line}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function waitFor<T>(find: () => T | null, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = find();
      if (found) { resolve(found); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('harness: element never appeared')); return; }
      setTimeout(tick, 30);
    };
    tick();
  });
}

function Workbench({ scene }: { scene: Scene }) {
  return (
    <MemoryRouter>
      <Page />
      {scene === 'space-settings' && <SpaceSettingsModal />}
      {scene === 'create-space' && <CreateSpaceModal />}
      {scene === 'join-space' && <JoinSpaceModal />}
      {scene === 'transfer' && <TransferOwnershipModal spaceId={SPACE_ID} onClose={() => undefined} />}
      {scene === 'confirm' && (
        <ConfirmDialog
          isOpen
          onClose={() => undefined}
          onConfirm={() => undefined}
          title="Delete #announcements?"
          description="Every message in it is deleted for everyone. This cannot be undone."
          confirmLabel="Delete Channel"
          variant="danger"
        />
      )}
    </MemoryRouter>
  );
}

async function start(): Promise<void> {
  const raw = new URLSearchParams(window.location.search).get('scene');
  const scene: Scene = SCENES.find((s) => s === raw) ?? 'space-settings';
  initializeInterfaceScale();
  await initI18n();
  stubFetch();
  useAuthStore.setState({ user: user('owner', 'Jannis') });
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    roles: [EVERYONE],
    members: MEMBERS,
    spacePermissions: new Map([[SPACE_ID, permissionsToString(ALL_PERMISSIONS)]]),
    loadSpaceDetail: async () => undefined,
  });
  const modal = scene === 'space-settings' ? 'spaceSettings' : scene === 'create-space' ? 'createSpace' : scene === 'join-space' ? 'joinSpace' : null;
  useUIStore.setState({ activeModal: modal, modalData: {} });
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Workbench scene={scene} />);
  if (scene === 'space-settings') {
    const name = await waitFor(() => document.querySelector<HTMLInputElement>('.glass-modal input[type="text"]'));
    typeInto(name, 'Aether Drift, after hours');
  }
}

void start();
