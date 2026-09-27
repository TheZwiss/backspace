import { describe, it, expect } from 'vitest';
import type { User } from '@backspace/shared';
import {
  isMyFederatedIdentity,
  myChosenStatus,
  ownStatusReport,
  statusAuthority,
  statusToAssertOnRemote,
} from './selfStatus';

const PAGE_HOST = 'orbit.example';

/** jannis, native on the page's instance (orbit). */
const native = {
  id: 'jannis-orbit', status: 'dnd', homeInstance: null, homeUserId: null, federationHomeOrphaned: false,
} as Pick<User, 'id' | 'status' | 'homeInstance' | 'homeUserId' | 'federationHomeOrphaned'>;

/** erin@nova signed in directly on orbit: a replicated row whose home is nova. */
const replicated = {
  id: 'erin-on-orbit', status: 'online', homeInstance: 'nova.example', homeUserId: 'erin-nova', federationHomeOrphaned: false,
} as Pick<User, 'id' | 'status' | 'homeInstance' | 'homeUserId' | 'federationHomeOrphaned'>;

/** A detached account on orbit: its old home was reset, so it owns its choice. */
const detached = {
  id: 'kim-orbit', status: 'idle', homeInstance: 'reset.example', homeUserId: 'kim-old', federationHomeOrphaned: true,
} as Pick<User, 'id' | 'status' | 'homeInstance' | 'homeUserId' | 'federationHomeOrphaned'>;

const HOME = { origin: '', isHome: true };
const NOVA = { origin: 'https://nova.example', isHome: false };
const OTHER = { origin: 'https://other.example', isHome: false };

describe('statusAuthority', () => {
  it('is the session for a native or detached account', () => {
    expect(statusAuthority(native)).toEqual({ kind: 'session', userId: 'jannis-orbit' });
    expect(statusAuthority(detached)).toEqual({ kind: 'session', userId: 'kim-orbit' });
  });

  it('is the true home for a replicated account', () => {
    expect(statusAuthority(replicated)).toEqual({ kind: 'trueHome', host: 'nova.example', userId: 'erin-nova' });
  });

  it('is null without a user', () => {
    expect(statusAuthority(null)).toBeNull();
  });
});

describe('myChosenStatus', () => {
  it("reads the session account's own status when it owns the choice", () => {
    expect(myChosenStatus(native, 'online')).toBe('dnd');
    expect(myChosenStatus(detached, null)).toBe('idle');
  });

  it("reads the true home's report for a replicated account, never the page row", () => {
    expect(myChosenStatus(replicated, 'dnd')).toBe('dnd');
    expect(myChosenStatus(replicated, null)).toBeNull();
  });
});

describe('ownStatusReport', () => {
  it("takes the session account's own status from the page's instance", () => {
    expect(ownStatusReport(native, HOME, { userId: 'jannis-orbit', status: 'idle' }))
      .toEqual({ owner: 'session', status: 'idle' });
  });

  it("ignores a remote instance's view of a session-owned account", () => {
    expect(ownStatusReport(native, NOVA, { userId: 'jannis-orbit', status: 'online' })).toBeNull();
    expect(ownStatusReport(native, NOVA, { userId: 'jannis-on-nova', status: 'online' })).toBeNull();
  });

  it("takes a replicated session's status from its true home, as that home's own row", () => {
    expect(ownStatusReport(replicated, NOVA, { userId: 'erin-nova', status: 'dnd' }))
      .toEqual({ owner: 'trueHome', status: 'dnd' });
  });

  it("ignores the page instance's replicated row and any other instance", () => {
    expect(ownStatusReport(replicated, HOME, { userId: 'erin-on-orbit', status: 'online' })).toBeNull();
    expect(ownStatusReport(replicated, OTHER, { userId: 'erin-nova', status: 'online' })).toBeNull();
  });

  it('ignores other users and offline', () => {
    expect(ownStatusReport(native, HOME, { userId: 'someone', status: 'dnd' })).toBeNull();
    expect(ownStatusReport(native, HOME, { userId: 'jannis-orbit', status: 'offline' })).toBeNull();
  });
});

describe('isMyFederatedIdentity', () => {
  it('matches a remote row homed on the true home with the same home user id', () => {
    expect(isMyFederatedIdentity(native, { homeInstance: 'orbit.example', homeUserId: 'jannis-orbit' }, PAGE_HOST)).toBe(true);
    expect(isMyFederatedIdentity(native, { homeInstance: 'https://orbit.example:443', homeUserId: 'jannis-orbit' }, PAGE_HOST)).toBe(true);
  });

  it('rejects a separate native account and a different identity', () => {
    expect(isMyFederatedIdentity(native, { homeInstance: null, homeUserId: null }, PAGE_HOST)).toBe(false);
    expect(isMyFederatedIdentity(native, { homeInstance: 'orbit.example', homeUserId: 'someone-else' }, PAGE_HOST)).toBe(false);
    expect(isMyFederatedIdentity(native, { homeInstance: 'nova.example', homeUserId: 'jannis-orbit' }, PAGE_HOST)).toBe(false);
  });
});

describe('statusToAssertOnRemote', () => {
  const mirror = { homeInstance: 'orbit.example', homeUserId: 'jannis-orbit' };

  it("re-sends a session-owned choice to its own federated identity when that remote's view differs", () => {
    expect(statusToAssertOnRemote(native, { ...mirror, status: 'online' }, PAGE_HOST)).toBe('dnd');
    expect(statusToAssertOnRemote(native, { ...mirror, status: 'offline' }, PAGE_HOST)).toBe('dnd');
  });

  it('sends nothing when the remote already agrees', () => {
    expect(statusToAssertOnRemote(native, { ...mirror, status: 'dnd' }, PAGE_HOST)).toBeNull();
  });

  it("never sends from a replicated session: its page row is not the user's choice", () => {
    // erin@nova on orbit, nova's ready: sending orbit's fallback 'online' here
    // would overwrite her dnd on the true home.
    expect(statusToAssertOnRemote(
      replicated,
      { homeInstance: null, homeUserId: null, status: 'dnd' },
      PAGE_HOST,
    )).toBeNull();
  });

  it('never sends to an account that is not this user', () => {
    expect(statusToAssertOnRemote(native, { homeInstance: null, homeUserId: null, status: 'online' }, PAGE_HOST)).toBeNull();
    expect(statusToAssertOnRemote(native, { homeInstance: 'orbit.example', homeUserId: 'other', status: 'online' }, PAGE_HOST)).toBeNull();
  });
});
