import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

const { isElectronMock } = vi.hoisted(() => ({ isElectronMock: vi.fn(() => false) }));
vi.mock('../../platform/platform', async () => {
  const actual = await vi.importActual<typeof import('../../platform/platform')>('../../platform/platform');
  return { ...actual, isElectron: () => isElectronMock() };
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { InstanceInfoResponse, User } from '@backspace/shared';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useExploreStore } from '../../stores/exploreStore';
import { useProjectHubStore } from '../../stores/projectHubStore';
import { useUIStore } from '../../stores/uiStore';
import { useHubUpdateState } from '../../hooks/useHubUpdateState';
import { __resetHomeInstanceInfoForTests, useHomeInstanceInfo } from '../../hooks/useHomeInstanceInfo';
import { readHubSeenVersion, writeHubSeenVersion } from '../../utils/hubSeenVersion';
import { describeEnvironment } from '../../utils/describeEnvironment';
import {
  PROJECT_LINKS,
  bugReportUrl,
  featureRequestUrl,
  releaseNotesUrl,
  type ProjectLinks,
} from '../../utils/projectLinks';
import { ProjectHubPage } from './ProjectHubPage';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function user(id: string): User {
  return {
    id,
    username: id,
    displayName: null,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 0,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  };
}

function info(overrides: Partial<InstanceInfoResponse> = {}): InstanceInfoResponse {
  return {
    name: 'Nova',
    version: '1.5.1',
    registrationOpen: true,
    federatedRegistrationOpen: true,
    instanceId: 'instance-1',
    sourceCodeUrl: 'https://git.example.org/fork',
    commit: 'abc1234',
    directoryConfigured: false,
    directoryAvailable: false,
    directoryEnabled: false,
    supportCardEnabled: true,
    ...overrides,
  };
}

const FILLED: ProjectLinks = {
  ...PROJECT_LINKS,
  funding: 'https://ko-fi.com/example',
  community: { origin: 'https://community.example', spaceId: 'space-1' },
};

const EMPTY: ProjectLinks = { ...PROJECT_LINKS, funding: null, community: null };

const CARD_ORDER = [
  "What's new",
  'Join the Backspace community',
  'Support the project',
  'Insights',
  'Report a bug or request a feature',
  'Host your own instance',
  'Get the desktop app',
];

const openModal = vi.fn();
const fetchMyRequests = vi.fn(async () => {});
const originalMarkSeen = useProjectHubStore.getState().markSeen;

/** Reports what every other surface (sidebar, You tab) would show for the dot. */
function DotProbe() {
  const { state } = useHubUpdateState();
  return <output data-testid="dot-state">{state}</output>;
}

function renderPage(props: { links?: ProjectLinks; showTopBar?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={['/backspace']}>
      <ProjectHubPage {...props} />
      <DotProbe />
    </MemoryRouter>,
  );
}

function card(name: string): HTMLElement {
  return screen.getByRole('article', { name });
}

function cardNames(): string[] {
  return screen.getAllByRole('article').map((el) => {
    const labelId = el.getAttribute('aria-labelledby');
    return labelId ? (document.getElementById(labelId)?.textContent ?? '') : '';
  });
}

/** Lets a rejected info request settle so the page shows its failed state. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  localStorage.clear();
  __resetHomeInstanceInfoForTests();
  isElectronMock.mockReturnValue(false);
  openModal.mockReset();
  fetchMyRequests.mockClear();
  useProjectHubStore.setState({ userId: null, seenVersion: null, markSeen: originalMarkSeen });
  useAuthStore.setState({ user: user('alice') });
  useUIStore.setState({ isMobile: false, activeModal: null, modalData: {}, openModal });
  useExploreStore.setState({ myRequests: [], fetchMyRequests });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  __resetHomeInstanceInfoForTests();
  useProjectHubStore.setState({ userId: null, seenVersion: null, markSeen: originalMarkSeen });
  useAuthStore.setState({ user: null });
});

// ── What's new and the seen version ──────────────────────────────────────────

describe('ProjectHubPage: What\'s new', () => {
  it('keeps saying "Updated to" for the visit while the dot clears everywhere else', async () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.0');
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage();

    await waitFor(() => expect(card("What's new")).toHaveTextContent('Updated to 1.5.1'));
    await waitFor(() => expect(screen.getByTestId('dot-state')).toHaveTextContent('current'));
    expect(useProjectHubStore.getState().seenVersion).toBe('1.5.1');
    expect(readHubSeenVersion(localStorage, 'alice')).toBe('1.5.1');
    expect(card("What's new")).toHaveTextContent('Updated to 1.5.1');
  });

  it('says which version is running on a first visit', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage();

    await waitFor(() => expect(card("What's new")).toHaveTextContent("You're on 1.5.1"));
    expect(readHubSeenVersion(localStorage, 'alice')).toBe('1.5.1');
  });

  it('links to the notes of the running version', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage();

    await waitFor(() => expect(card("What's new")).toHaveTextContent("You're on 1.5.1"));
    const link = within(card("What's new")).getByRole('link', { name: /Read the release notes/ });
    expect(link).toHaveAttribute('href', releaseNotesUrl('1.5.1'));
    expect(link.getAttribute('href')).toBe('https://github.com/TheZwiss/backspace/releases/tag/v1.5.1');
  });

  it('with failed info says noVersion, links to the release list and marks nothing', async () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.0');
    const spy = vi.spyOn(api.instance, 'info').mockRejectedValue(new Error('offline'));

    renderPage();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();

    const whatsNew = card("What's new");
    expect(whatsNew).toHaveTextContent('Release notes for every version');
    expect(within(whatsNew).getByRole('link', { name: /Read the release notes/ })).toHaveAttribute(
      'href',
      PROJECT_LINKS.releases,
    );
    expect(readHubSeenVersion(localStorage, 'alice')).toBe('1.5.0');
  });

  it('an account switch that lands on the page marks the new account only', async () => {
    writeHubSeenVersion(localStorage, 'alice', '1.5.0');
    writeHubSeenVersion(localStorage, 'bob', '1.5.0');
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    // The sidebar has the info cached already, so the page's very first
    // render knows the version, while the store still holds Alice's record.
    const primer = render(<InfoPrimer />);
    await waitFor(() => expect(screen.getByTestId('primed')).toHaveTextContent('1.5.1'));
    useProjectHubStore.getState().load('alice');
    useAuthStore.setState({ user: user('bob') });

    renderPage();

    await waitFor(() => expect(readHubSeenVersion(localStorage, 'bob')).toBe('1.5.1'));
    expect(readHubSeenVersion(localStorage, 'alice')).toBe('1.5.0');
    expect(card("What's new")).toHaveTextContent('Updated to 1.5.1');
    expect(useProjectHubStore.getState().userId).toBe('bob');
    primer.unmount();
  });
});

function InfoPrimer() {
  const cached = useHomeInstanceInfo();
  return <output data-testid="primed">{cached?.version ?? ''}</output>;
}

// ── Which cards show ─────────────────────────────────────────────────────────

describe('ProjectHubPage: cards', () => {
  it('shows every card in order when both links are set and nothing hides one', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    const { container } = renderPage({ links: FILLED });

    await waitFor(() => expect(screen.queryByRole('article', { name: 'Support the project' })).toBeInTheDocument());
    expect(cardNames()).toEqual(CARD_ORDER);
    const grid = card("What's new").parentElement as HTMLElement;
    expect(grid).toHaveClass('card-grid');
    expect(container.innerHTML).not.toMatch(/\bmd:/);
  });

  it('shows the Support card linking to the funding page when both conditions hold', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage({ links: FILLED });

    const support = await screen.findByRole('article', { name: 'Support the project' });
    expect(within(support).getByRole('link', { name: /Support on Ko-fi/ })).toHaveAttribute(
      'href',
      'https://ko-fi.com/example',
    );
  });

  it('hides the Support card when there is no funding link', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage({ links: { ...FILLED, funding: null } });

    await waitFor(() => expect(card("What's new")).toHaveTextContent('1.5.1'));
    expect(screen.queryByRole('article', { name: 'Support the project' })).toBeNull();
  });

  it('hides the Support card when the admin turned it off', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info({ supportCardEnabled: false }));

    renderPage({ links: FILLED });

    await waitFor(() => expect(card("What's new")).toHaveTextContent('1.5.1'));
    expect(screen.queryByRole('article', { name: 'Support the project' })).toBeNull();
  });

  it('hides the Support card while the instance info is loading', () => {
    vi.spyOn(api.instance, 'info').mockReturnValue(new Promise<InstanceInfoResponse>(() => {}));

    renderPage({ links: FILLED });

    expect(card("What's new")).toHaveTextContent('Release notes for every version');
    expect(screen.queryByRole('article', { name: 'Support the project' })).toBeNull();
  });

  it('hides the Support card when the instance info failed', async () => {
    const spy = vi.spyOn(api.instance, 'info').mockRejectedValue(new Error('offline'));

    renderPage({ links: FILLED });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();

    expect(screen.queryByRole('article', { name: 'Support the project' })).toBeNull();
  });

  it('leaves out the community card when there is no community target', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage({ links: EMPTY });

    await waitFor(() => expect(card("What's new")).toHaveTextContent('1.5.1'));
    expect(screen.queryByRole('article', { name: 'Join the Backspace community' })).toBeNull();
    expect(fetchMyRequests).not.toHaveBeenCalled();
    expect(cardNames()).toEqual([
      "What's new",
      'Insights',
      'Report a bug or request a feature',
      'Host your own instance',
      'Get the desktop app',
    ]);
  });

  it('shows the community card when a target is set', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage({ links: FILLED });

    const community = await screen.findByRole('article', { name: 'Join the Backspace community' });
    expect(within(community).getByRole('button', { name: 'Join' })).toBeEnabled();
  });

  it('links Insights and the install guide', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage();

    await waitFor(() => expect(card("What's new")).toHaveTextContent('1.5.1'));
    expect(within(card('Insights')).getByRole('link', { name: /Open insights/ })).toHaveAttribute(
      'href',
      PROJECT_LINKS.insights,
    );
    expect(within(card('Host your own instance')).getByRole('link', { name: /Read the install guide/ })).toHaveAttribute(
      'href',
      PROJECT_LINKS.installGuide,
    );
  });

  it('prefills the bug report with the version and environment, and links the feature form', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage();

    await waitFor(() => expect(card("What's new")).toHaveTextContent('1.5.1'));
    const report = card('Report a bug or request a feature');
    const bug = within(report).getByRole('link', { name: /Report a bug/ });
    const environment = describeEnvironment(navigator.userAgent, false);
    expect(bug).toHaveAttribute('href', bugReportUrl({ version: '1.5.1', environment }));
    const params = new URL(bug.getAttribute('href') ?? '').searchParams;
    expect(params.get('template')).toBe('bug_report.yml');
    expect(params.get('version')).toBe('1.5.1');
    expect(params.get('environment')).toBe(environment);
    expect(within(report).getByRole('link', { name: /Request a feature/ })).toHaveAttribute('href', featureRequestUrl());
  });

  it('reports the desktop app as the environment inside Electron', async () => {
    isElectronMock.mockReturnValue(true);
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage();

    await waitFor(() => expect(card("What's new")).toHaveTextContent('1.5.1'));
    const bug = within(card('Report a bug or request a feature')).getByRole('link', { name: /Report a bug/ });
    const params = new URL(bug.getAttribute('href') ?? '').searchParams;
    expect(params.get('environment')).toBe(describeEnvironment(navigator.userAgent, true));
  });

  it('leaves the version out of the bug report when info failed', async () => {
    const spy = vi.spyOn(api.instance, 'info').mockRejectedValue(new Error('offline'));

    renderPage();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();

    const bug = within(card('Report a bug or request a feature')).getByRole('link', { name: /Report a bug/ });
    expect(new URL(bug.getAttribute('href') ?? '').searchParams.has('version')).toBe(false);
  });

  it('opens the desktop tab of the user settings from the desktop card', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage();

    fireEvent.click(within(card('Get the desktop app')).getByRole('button', { name: 'Download' }));
    expect(openModal).toHaveBeenCalledWith('userSettings', { tab: 'desktop' });
  });

  it('hides the desktop card inside the desktop app', async () => {
    isElectronMock.mockReturnValue(true);
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage();

    await waitFor(() => expect(card("What's new")).toHaveTextContent('1.5.1'));
    expect(screen.queryByRole('article', { name: 'Get the desktop app' })).toBeNull();
  });

  it('hides the desktop card on the mobile layout', async () => {
    useUIStore.setState({ isMobile: true });
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage();

    await waitFor(() => expect(card("What's new")).toHaveTextContent('1.5.1'));
    expect(screen.queryByRole('article', { name: 'Get the desktop app' })).toBeNull();
  });
});

// ── Frame, "This instance" and the footer ────────────────────────────────────

describe('ProjectHubPage: frame', () => {
  it('shows the header with the mark, title and tagline', () => {
    vi.spyOn(api.instance, 'info').mockReturnValue(new Promise<InstanceInfoResponse>(() => {}));

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Backspace' })).toBeInTheDocument();
    expect(screen.getByText('Open-source chat you can host yourself.')).toBeInTheDocument();
    expect(document.querySelector('img[src="/icons/logo-mark.svg"]')).not.toBeNull();
  });

  it('has a top bar with the member list toggle by default', () => {
    vi.spyOn(api.instance, 'info').mockReturnValue(new Promise<InstanceInfoResponse>(() => {}));

    renderPage();

    expect(screen.getByRole('button', { name: 'Toggle Member List' })).toBeInTheDocument();
  });

  it('omits the top bar with showTopBar={false}', () => {
    vi.spyOn(api.instance, 'info').mockReturnValue(new Promise<InstanceInfoResponse>(() => {}));

    renderPage({ showTopBar: false });

    expect(screen.queryByRole('button', { name: 'Toggle Member List' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Backspace' })).toBeInTheDocument();
  });

  it('names this instance and its domain and offers its source', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    renderPage();

    const section = screen.getByRole('region', { name: 'This instance' });
    await waitFor(() => expect(section).toHaveTextContent('Nova'));
    expect(section).toHaveTextContent(window.location.host);
    const source = within(section).getByRole('link', { name: /Source code \(AGPL\)/ });
    expect(source).toHaveAttribute('href', 'https://git.example.org/fork');
    expect(source).toHaveTextContent('v1.5.1 (abc1234)');
  });

  it('shows the domain alone when the instance info failed', async () => {
    const spy = vi.spyOn(api.instance, 'info').mockRejectedValue(new Error('offline'));

    renderPage();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();

    const section = screen.getByRole('region', { name: 'This instance' });
    expect(section).toHaveTextContent(window.location.host);
    expect(section).not.toHaveTextContent('Nova');
    expect(within(section).queryByRole('link')).toBeNull();
  });

  it('links the license, security policy, contributors and repository in the footer', () => {
    vi.spyOn(api.instance, 'info').mockReturnValue(new Promise<InstanceInfoResponse>(() => {}));

    renderPage();

    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'License (AGPL-3.0)' })).toHaveAttribute('href', PROJECT_LINKS.license);
    expect(within(footer).getByRole('link', { name: 'Report a security issue' })).toHaveAttribute('href', PROJECT_LINKS.security);
    expect(within(footer).getByRole('link', { name: 'Contributors' })).toHaveAttribute('href', PROJECT_LINKS.contributors);
    expect(within(footer).getByRole('link', { name: 'Source code on GitHub' })).toHaveAttribute('href', PROJECT_LINKS.repository);
  });

  it('opens every outbound link in a new tab without an opener or referrer', async () => {
    vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    const { container } = renderPage({ links: FILLED });
    await screen.findByRole('article', { name: 'Support the project' });

    const links = Array.from(container.querySelectorAll('a'));
    expect(links.length).toBeGreaterThanOrEqual(11);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      const rel = (link.getAttribute('rel') ?? '').split(/\s+/);
      expect(rel).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    }
  });
});
