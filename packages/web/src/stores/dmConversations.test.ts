import { describe, it, expect } from 'vitest';
import {
  EMPTY_DM_CONVERSATIONS,
  mergeOriginListing,
  upsertCopy,
  upsertUnplacedCopy,
  removeCopy,
  patchCopy,
  patchEveryCopy,
  setOriginAvailable,
  dropOrigin,
  pinnedDmChannels,
  pinnedOriginByChannelId,
  conversationCopyIndex,
  copyIdOnOrigin,
  findCopy,
  type DmConversations,
  type DmPinContext,
} from './dmConversations';
import { wireDm, asListedBy161 } from '../test/dmWireShape';
import type { DmChannel, DmMessageWithUser, User } from '@backspace/shared';

/**
 * Unit tests of the client DM merge module (ADR 0002, Decision 4 and 5).
 *
 * Ported from `spaceStore.reloadDms.test.ts`, `spaceStore.dmAlternatives.test.ts`
 * and `utils/dmOriginFailover.test.ts`, plus one test per rule the module owns.
 */

const HOME = '';
const REMOTE = 'https://remote.example';
const C = 'https://c.example';
const AT_HOME: DmPinContext = { home: HOME };

// The key both instances give the alice-bob conversation (server oneOnOneKey).
const FID_ALICE_BOB = 'fc8aa3239ccea0cd4cbfb7701d770ac9';
const FID_GROUP = '0e0e0e0e-0000-4000-8000-000000000000';

function user(id: string, homeUserId: string | null = null, homeInstance: string | null = null): User {
  return {
    id, username: id, displayName: null, avatar: null, avatarColor: null, status: 'online',
    createdAt: 1, homeInstance, homeUserId,
  } as User;
}

const aliceHome = user('alice-home');
const aliceOnRemote = user('alice-on-remote', 'alice-home', 'home.example');
const bobOnHome = user('bob-stub-on-home', 'bob-remote', 'remote.example');
const bobOnRemote = user('bob-remote');
const carolHome = user('carol-home');
const carolOnRemote = user('carol-stub-on-remote', 'carol-home', 'home.example');

const bobDmHome = wireDm({ id: 'dm-bob-home', federatedId: FID_ALICE_BOB, createdAt: 1, members: [aliceHome, bobOnHome] });
const bobDmRemote = wireDm({ id: 'dm-bob-remote', federatedId: FID_ALICE_BOB, createdAt: 2, members: [aliceOnRemote, bobOnRemote] });
const bobDmC = wireDm({ id: 'dm-bob-c', federatedId: FID_ALICE_BOB, createdAt: 3, members: [aliceOnRemote, bobOnRemote] });
const carolDmHome = wireDm({ id: 'dm-carol', createdAt: 1, members: [aliceHome, carolHome] });
const groupOnRemote = wireDm({
  id: 'dm-group-remote',
  federatedId: FID_GROUP,
  ownerId: 'alice-on-remote',
  ownerHomeUserId: 'alice-home',
  ownerHomeInstance: 'home.example',
  name: 'Weekend plans',
  icon: 'https://remote.example/uploads/group.png',
  metadataUpdatedAt: 42,
  createdAt: 3,
  members: [aliceOnRemote, bobOnRemote, carolOnRemote],
});

function listing(state: DmConversations, origin: string, listed: DmChannel[], ctx: DmPinContext = AT_HOME, derived: Map<string, string> = new Map()): DmConversations {
  return mergeOriginListing(state, origin, listed, derived, ctx).next;
}

function rows(state: DmConversations): string[] {
  return pinnedDmChannels(state).map(d => d.id).sort();
}

function row(state: DmConversations, id: string): DmChannel | undefined {
  return pinnedDmChannels(state).find(d => d.id === id);
}

function keySourceOf(state: DmConversations, channelId: string): string | undefined {
  return findCopy(state, channelId)?.copy.keySource;
}

function message(dmChannelId: string, sender: User, content: string): DmMessageWithUser {
  return {
    id: `m-${dmChannelId}`, dmChannelId, userId: sender.id, user: sender, content,
    createdAt: 5_000, attachments: [], embeds: [], reactions: [],
  };
}

describe('dedup by key', () => {
  it('two origins that state the same key make one conversation with one row', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [carolDmHome, bobDmHome]);
    s = listing(s, REMOTE, [bobDmRemote]);

    expect(rows(s)).toEqual(['dm-bob-home', 'dm-carol']);
    expect(conversationCopyIndex(s).get(FID_ALICE_BOB)).toEqual(new Map([[HOME, 'dm-bob-home'], [REMOTE, 'dm-bob-remote']]));
  });

  it('accumulates one copy per origin for the same key, whichever arrives first (ported)', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [bobDmRemote]);
    s = listing(s, HOME, [bobDmHome]);

    const byOrigin = conversationCopyIndex(s).get(FID_ALICE_BOB);
    expect(byOrigin?.get(HOME)).toBe('dm-bob-home');
    expect(byOrigin?.get(REMOTE)).toBe('dm-bob-remote');
    expect(rows(s)).toEqual(['dm-bob-home']);
  });

  it('a later listing of the same origin replaces its copy, the other origins\' stay (ported)', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [{ ...bobDmRemote, id: 'remote-old' }]);
    s = listing(s, REMOTE, [{ ...bobDmRemote, id: 'remote-new' }]);

    expect(conversationCopyIndex(s).get(FID_ALICE_BOB)).toEqual(new Map([[REMOTE, 'remote-new']]));
  });

  it('a conversation with a stated null key is never folded into another', () => {
    const unkeyed = wireDm({ id: 'dm-bob-unkeyed', federatedId: null, createdAt: 5, members: [aliceOnRemote, bobOnRemote] });
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome]);
    s = listing(s, REMOTE, [unkeyed]);

    expect(rows(s)).toEqual(['dm-bob-home', 'dm-bob-unkeyed']);
    expect(row(s, 'dm-bob-unkeyed')?.federatedId).toBeNull();
    expect(keySourceOf(s, 'dm-bob-unkeyed')).toBe('stated-null');
  });

  it('keyless conversations are not indexed by key (ported)', () => {
    const s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome, carolDmHome]);
    expect([...conversationCopyIndex(s).keys()]).toEqual([FID_ALICE_BOB]);
  });

  it('a second copy the same origin states under one key keeps its own row rather than being dropped', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [bobDmRemote]);
    const second = upsertCopy(s, REMOTE, { ...bobDmRemote, id: 'dm-bob-remote-2' }, 'stated', AT_HOME);
    s = second.next;

    expect(rows(s)).toEqual(['dm-bob-remote', 'dm-bob-remote-2']);
    expect(conversationCopyIndex(s).get(FID_ALICE_BOB)).toEqual(new Map([[REMOTE, 'dm-bob-remote']]));
    expect(second.pinnedChannelId).toBe('dm-bob-remote-2');
  });
});

describe('completePeerListing: a peer on 1.6.1 or older lists DMs without the key', () => {
  it('its copy of a conversation already shown from home joins it through the derived key (ported)', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [carolDmHome, bobDmHome]);
    s = listing(s, REMOTE, [asListedBy161(bobDmRemote)], AT_HOME, new Map([['dm-bob-remote', FID_ALICE_BOB]]));

    expect(rows(s)).toEqual(['dm-bob-home', 'dm-carol']);
    expect(conversationCopyIndex(s).get(FID_ALICE_BOB)?.get(REMOTE)).toBe('dm-bob-remote');
    expect(keySourceOf(s, 'dm-bob-remote')).toBe('derived');
  });

  it('listed before the home copy is known, the home copy arriving later still makes one row (ported)', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [asListedBy161(bobDmRemote)], AT_HOME, new Map([['dm-bob-remote', FID_ALICE_BOB]]));
    expect(rows(s)).toEqual(['dm-bob-remote']);

    const merged = mergeOriginListing(s, HOME, [bobDmHome], new Map(), AT_HOME);
    s = merged.next;

    expect(rows(s)).toEqual(['dm-bob-home']);
    expect(pinnedOriginByChannelId(s).get('dm-bob-home')).toBe(HOME);
    expect(merged.pinMoves).toEqual([{ fromChannelId: 'dm-bob-remote', toChannelId: 'dm-bob-home', toOrigin: HOME }]);
  });

  it('a derived key never merges two rows the peer lists for the same pair (ported)', () => {
    const legacy = wireDm({ id: 'dm-bob-legacy', createdAt: 0, members: [aliceOnRemote, bobOnRemote] });
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [asListedBy161(legacy), asListedBy161(bobDmRemote)], AT_HOME,
      new Map([['dm-bob-legacy', FID_ALICE_BOB], ['dm-bob-remote', FID_ALICE_BOB]]));
    // Nothing known yet: both derive the same key, so neither keeps it.
    expect(rows(s)).toEqual(['dm-bob-legacy', 'dm-bob-remote']);

    // After REMOTE's ready stated both (null and the key), the next legacy
    // listing keeps what ready stated.
    s = listing(s, REMOTE, [legacy, bobDmRemote]);
    s = listing(s, REMOTE, [asListedBy161(legacy), asListedBy161(bobDmRemote)], AT_HOME,
      new Map([['dm-bob-legacy', FID_ALICE_BOB], ['dm-bob-remote', FID_ALICE_BOB]]));

    expect(rows(s)).toEqual(['dm-bob-legacy', 'dm-bob-remote']);
    expect(row(s, 'dm-bob-remote')?.federatedId).toBe(FID_ALICE_BOB);
    expect(row(s, 'dm-bob-legacy')?.federatedId).toBeNull();
  });

  it('a derived key shared by another entry of the same listing is dropped to unknown', () => {
    const legacy = wireDm({ id: 'dm-bob-legacy', createdAt: 0, members: [aliceOnRemote, bobOnRemote] });
    const s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [asListedBy161(legacy), bobDmRemote], AT_HOME,
      new Map([['dm-bob-legacy', FID_ALICE_BOB]]));

    expect(rows(s)).toEqual(['dm-bob-legacy', 'dm-bob-remote']);
    expect(keySourceOf(s, 'dm-bob-legacy')).toBe('unknown');
    expect(keySourceOf(s, 'dm-bob-remote')).toBe('stated');
  });

  it('a mirror id never seen before, alone in the list for its pair, derives the key and dedups against home (ported)', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [carolDmHome, bobDmHome]);
    s = listing(s, REMOTE, []);
    s = listing(s, REMOTE, [asListedBy161(bobDmRemote)], AT_HOME, new Map([['dm-bob-remote', FID_ALICE_BOB]]));

    expect(rows(s)).toEqual(['dm-bob-home', 'dm-carol']);
    expect(conversationCopyIndex(s).get(FID_ALICE_BOB)?.get(REMOTE)).toBe('dm-bob-remote');
  });

  it('a key already known for a listed channel is kept, not replaced by the missing field (ported)', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [groupOnRemote]);
    s = listing(s, REMOTE, [asListedBy161(groupOnRemote)]);

    expect(row(s, 'dm-group-remote')?.federatedId).toBe(FID_GROUP);
    expect(keySourceOf(s, 'dm-group-remote')).toBe('stated');
  });

  it('a group keeps its name, icon and owner identity when the list leaves them out (ported)', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [groupOnRemote]);
    s = listing(s, REMOTE, [asListedBy161(groupOnRemote)]);

    expect(row(s, 'dm-group-remote')).toMatchObject({
      federatedId: FID_GROUP,
      ownerId: 'alice-on-remote',
      ownerHomeUserId: 'alice-home',
      ownerHomeInstance: 'home.example',
      name: 'Weekend plans',
      icon: 'https://remote.example/uploads/group.png',
      metadataUpdatedAt: 42,
    });
  });

  it('a value the list sends as null replaces the one held (ported)', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [groupOnRemote]);
    s = listing(s, REMOTE, [{ ...groupOnRemote, icon: null, metadataUpdatedAt: 43 }]);

    expect(row(s, 'dm-group-remote')?.icon).toBeNull();
    expect(row(s, 'dm-group-remote')?.metadataUpdatedAt).toBe(43);
  });

  it('a 1-on-1 a current server lists without a key gets none made up for it (ported)', () => {
    const s = listing(EMPTY_DM_CONVERSATIONS, HOME, [carolDmHome]);
    expect(row(s, 'dm-carol')?.federatedId).toBeNull();
    expect(keySourceOf(s, 'dm-carol')).toBe('stated-null');
  });
});

describe('provenance of a stated null (#345)', () => {
  const unkeyed = wireDm({ id: 'dm-bob-unkeyed', federatedId: null, createdAt: 5, members: [aliceOnRemote, bobOnRemote] });

  it('a null a 1.6.1 peer stated in ready survives its keyless reload: the copy is not derived into the home row', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome]);
    s = listing(s, REMOTE, [unkeyed]);
    s = listing(s, REMOTE, [asListedBy161(unkeyed)], AT_HOME, new Map([['dm-bob-unkeyed', FID_ALICE_BOB]]));

    expect(rows(s)).toEqual(['dm-bob-home', 'dm-bob-unkeyed']);
    expect(keySourceOf(s, 'dm-bob-unkeyed')).toBe('stated-null');
  });

  it('a null the client wrote for an unplaced message is replaced by the next listing that contains the id', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome]);
    const placed = upsertUnplacedCopy(s, REMOTE, message('dm-bob-remote', aliceOnRemote, 'test'), AT_HOME);
    s = placed.next;
    expect(placed.pinnedChannelId).toBe('dm-bob-remote');
    expect(rows(s)).toEqual(['dm-bob-home', 'dm-bob-remote']);
    expect(keySourceOf(s, 'dm-bob-remote')).toBe('unknown');

    const reloaded = mergeOriginListing(s, REMOTE, [asListedBy161(bobDmRemote)], new Map([['dm-bob-remote', FID_ALICE_BOB]]), AT_HOME);
    s = reloaded.next;

    expect(rows(s)).toEqual(['dm-bob-home']);
    expect(keySourceOf(s, 'dm-bob-remote')).toBe('derived');
    // The row the user may be looking at moves to the conversation's pinned copy.
    expect(reloaded.pinMoves).toEqual([{ fromChannelId: 'dm-bob-remote', toChannelId: 'dm-bob-home', toOrigin: HOME }]);
  });

  it('the unplaced entry carries the message as its preview and its sender as a member', () => {
    const s = upsertUnplacedCopy(EMPTY_DM_CONVERSATIONS, REMOTE, message('dm-x', bobOnRemote, 'hi'), AT_HOME).next;
    expect(row(s, 'dm-x')).toMatchObject({ id: 'dm-x', federatedId: null, createdAt: 5_000 });
    expect(row(s, 'dm-x')?.members.map(m => m.id)).toEqual(['bob-remote']);
    expect(row(s, 'dm-x')?.lastMessage?.content).toBe('hi');
  });

  it('an event that leaves the key out keeps the key the copy already had', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [groupOnRemote]);
    s = upsertCopy(s, REMOTE, asListedBy161(groupOnRemote), 'stated', AT_HOME).next;
    expect(row(s, 'dm-group-remote')?.federatedId).toBe(FID_GROUP);
    expect(row(s, 'dm-group-remote')?.name).toBe('Weekend plans');
  });
});

describe('pin rule', () => {
  it('the home copy takes the pin when it arrives after a sibling\'s', () => {
    let s = upsertCopy(EMPTY_DM_CONVERSATIONS, C, bobDmC, 'stated', AT_HOME).next;
    expect(pinnedOriginByChannelId(s).get('dm-bob-c')).toBe(C);

    const home = upsertCopy(s, HOME, bobDmHome, 'stated', AT_HOME);
    s = home.next;

    expect(rows(s)).toEqual(['dm-bob-home']);
    expect(home.pinnedChannelId).toBe('dm-bob-home');
    expect(home.pinMoves).toEqual([{ fromChannelId: 'dm-bob-c', toChannelId: 'dm-bob-home', toOrigin: HOME }]);
  });

  it('once pinned to home, a sibling\'s copy arriving later does not move it', () => {
    let s = upsertCopy(EMPTY_DM_CONVERSATIONS, HOME, bobDmHome, 'stated', AT_HOME).next;
    const sibling = upsertCopy(s, C, bobDmC, 'stated', AT_HOME);
    s = sibling.next;

    expect(rows(s)).toEqual(['dm-bob-home']);
    expect(sibling.pinnedChannelId).toBe('dm-bob-home');
    expect(sibling.pinMoves).toEqual([]);
  });

  it('home is the layout home: for an account homed on REMOTE, REMOTE\'s copy is pinned over the browsed instance\'s', () => {
    const atRemote: DmPinContext = { home: REMOTE };
    let s = upsertCopy(EMPTY_DM_CONVERSATIONS, HOME, bobDmHome, 'stated', atRemote).next;
    const created = upsertCopy(s, REMOTE, bobDmRemote, 'stated', atRemote);
    s = created.next;
    expect(rows(s)).toEqual(['dm-bob-remote']);
    expect(created.pinnedChannelId).toBe('dm-bob-remote');
  });

  it('upsertCopy answers the pinned copy\'s id, which is where the UI navigates', () => {
    const atRemote: DmPinContext = { home: REMOTE };
    const s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [bobDmRemote], atRemote);
    const created = upsertCopy(s, HOME, bobDmHome, 'stated', atRemote);
    expect(created.pinnedChannelId).toBe('dm-bob-remote');
    expect(rows(created.next)).toEqual(['dm-bob-remote']);
  });
});

describe('failover moves the pin (ported from dmOriginFailover)', () => {
  function pinnedToRemote(): DmConversations {
    // REMOTE's copy was first and home's copy is unknown; C also holds one.
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [bobDmRemote]);
    s = listing(s, C, [bobDmC]);
    return s;
  }

  it('no-ops when the unavailable origin pins nothing', () => {
    const s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome]);
    const op = setOriginAvailable(s, REMOTE, false, AT_HOME);
    expect(op.pinMoves).toEqual([]);
    expect(pinnedOriginByChannelId(op.next).get('dm-bob-home')).toBe(HOME);
  });

  it('moves the pin to the home copy when the pinned origin drops', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [bobDmRemote]);
    // Home's copy is known, but a layout home elsewhere left REMOTE pinned.
    s = listing(s, HOME, [bobDmHome], { home: REMOTE });
    expect(rows(s)).toEqual(['dm-bob-remote']);

    const op = setOriginAvailable(s, REMOTE, false, { home: REMOTE });
    expect(op.pinMoves).toEqual([{ fromChannelId: 'dm-bob-remote', toChannelId: 'dm-bob-home', toOrigin: HOME }]);
    expect(rows(op.next)).toEqual(['dm-bob-home']);
  });

  it('falls back to a connected sibling when home holds no copy', () => {
    const op = setOriginAvailable(pinnedToRemote(), REMOTE, false, AT_HOME);
    expect(op.pinMoves).toEqual([{ fromChannelId: 'dm-bob-remote', toChannelId: 'dm-bob-c', toOrigin: C }]);
    expect(pinnedOriginByChannelId(op.next).get('dm-bob-c')).toBe(C);
  });

  it('leaves the pin where it is when no other copy is connected', () => {
    let s = setOriginAvailable(pinnedToRemote(), C, false, AT_HOME).next;
    const op = setOriginAvailable(s, REMOTE, false, AT_HOME);
    s = op.next;
    expect(op.pinMoves).toEqual([]);
    expect(rows(s)).toEqual(['dm-bob-remote']);
  });

  it('a conversation with a single copy keeps it', () => {
    const s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [wireDm({ id: 'dm-local', createdAt: 1, members: [] })]);
    const op = setOriginAvailable(s, REMOTE, false, AT_HOME);
    expect(op.pinMoves).toEqual([]);
    expect(rows(op.next)).toEqual(['dm-local']);
  });

  it('keeps the old copy after the move, so a later fail-back needs no new listing', () => {
    const s = setOriginAvailable(pinnedToRemote(), REMOTE, false, AT_HOME).next;
    expect(conversationCopyIndex(s).get(FID_ALICE_BOB)?.get(REMOTE)).toBe('dm-bob-remote');
    // C drops too while REMOTE is back: the pin goes back to REMOTE's copy.
    const back = setOriginAvailable(setOriginAvailable(s, REMOTE, true, AT_HOME).next, C, false, AT_HOME);
    expect(back.pinMoves).toEqual([{ fromChannelId: 'dm-bob-c', toChannelId: 'dm-bob-remote', toOrigin: REMOTE }]);
  });

  it('a returning sibling never takes the pin back', () => {
    let s = setOriginAvailable(pinnedToRemote(), REMOTE, false, AT_HOME).next;
    const op = mergeOriginListing(s, REMOTE, [bobDmRemote], new Map(), AT_HOME);
    s = op.next;
    expect(op.pinMoves).toEqual([]);
    expect(rows(s)).toEqual(['dm-bob-c']);
  });

  it('the returning home takes the pin back', () => {
    const atRemote: DmPinContext = { home: REMOTE };
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [bobDmRemote], atRemote);
    s = listing(s, C, [bobDmC], atRemote);
    s = setOriginAvailable(s, REMOTE, false, atRemote).next;
    expect(rows(s)).toEqual(['dm-bob-c']);

    const op = mergeOriginListing(s, REMOTE, [bobDmRemote], new Map(), atRemote);
    expect(op.pinMoves).toEqual([{ fromChannelId: 'dm-bob-c', toChannelId: 'dm-bob-remote', toOrigin: REMOTE }]);
  });
});

describe('dropOrigin (ported from removeInstanceSpaces)', () => {
  it('drops the origin\'s copies, keeps the others, and moves pins off it', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [bobDmRemote, groupOnRemote]);
    s = listing(s, HOME, [bobDmHome], { home: REMOTE });
    const op = dropOrigin(s, REMOTE, { home: REMOTE });
    s = op.next;

    expect(rows(s)).toEqual(['dm-bob-home']);
    expect(conversationCopyIndex(s).get(FID_ALICE_BOB)).toEqual(new Map([[HOME, 'dm-bob-home']]));
    expect(conversationCopyIndex(s).has(FID_GROUP)).toBe(false);
    expect(op.pinMoves).toEqual([{ fromChannelId: 'dm-bob-remote', toChannelId: 'dm-bob-home', toOrigin: HOME }]);
  });
});

describe('removeCopy', () => {
  it('removing the pinned copy removes the row, as closing a DM always did', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome, carolDmHome]);
    s = listing(s, REMOTE, [bobDmRemote]);
    const op = removeCopy(s, 'dm-bob-home', AT_HOME);
    expect(rows(op.next)).toEqual(['dm-carol']);
    expect(op.pinMoves).toEqual([]);
  });

  it('removing a mirrored copy leaves the row on the pinned copy', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome]);
    s = listing(s, REMOTE, [bobDmRemote]);
    s = removeCopy(s, 'dm-bob-remote', AT_HOME).next;
    expect(rows(s)).toEqual(['dm-bob-home']);
    expect(conversationCopyIndex(s).get(FID_ALICE_BOB)).toEqual(new Map([[HOME, 'dm-bob-home']]));
  });

  it('an unknown id changes nothing', () => {
    const s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome]);
    expect(removeCopy(s, 'nope', AT_HOME).next).toBe(s);
  });
});

describe('patchCopy and patchEveryCopy', () => {
  it('patches the copy with that id, keeping its id and key', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, REMOTE, [groupOnRemote]);
    s = patchCopy(s, 'dm-group-remote', dm => ({ ...dm, name: 'Renamed', id: 'other', federatedId: null })).next;
    expect(row(s, 'dm-group-remote')).toMatchObject({ name: 'Renamed', federatedId: FID_GROUP });
  });

  it('patches a mirrored copy too, which the row shows once that copy is pinned', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome]);
    s = listing(s, REMOTE, [bobDmRemote]);
    s = patchCopy(s, 'dm-bob-remote', dm => ({ ...dm, members: [aliceOnRemote] })).next;
    expect(findCopy(s, 'dm-bob-remote')?.copy.channel.members.map(m => m.id)).toEqual(['alice-on-remote']);
    expect(row(s, 'dm-bob-home')?.members).toHaveLength(2);
  });

  it('patchEveryCopy reaches every copy', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome, carolDmHome]);
    s = listing(s, REMOTE, [bobDmRemote]);
    s = patchEveryCopy(s, dm => ({ ...dm, name: 'x' })).next;
    for (const id of ['dm-bob-home', 'dm-bob-remote', 'dm-carol']) {
      expect(findCopy(s, id)?.copy.channel.name).toBe('x');
    }
  });

  it('an unknown id changes nothing', () => {
    const s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome]);
    expect(patchCopy(s, 'nope', dm => dm).next).toBe(s);
  });
});

describe('copyIdOnOrigin', () => {
  it('answers the id the given origin holds for the conversation of any of its copies', () => {
    let s = listing(EMPTY_DM_CONVERSATIONS, HOME, [bobDmHome]);
    s = listing(s, REMOTE, [bobDmRemote]);
    expect(copyIdOnOrigin(s, 'dm-bob-remote', HOME)).toBe('dm-bob-home');
    expect(copyIdOnOrigin(s, 'dm-bob-home', REMOTE)).toBe('dm-bob-remote');
    expect(copyIdOnOrigin(s, 'dm-bob-home', C)).toBeNull();
    expect(copyIdOnOrigin(s, 'nope', HOME)).toBeNull();
  });
});
