import { afterEach, describe, expect, it } from 'vitest';
import type { Reaction, User } from '@backspace/shared';
import i18n from '../../i18n';
import { setLanguage } from '../../i18n';
import { formatters } from '../../i18n/formatters';
import { reactionSentence, summarizeReactors } from './reactionSummary';

function user(id: string, username: string, displayName: string | null = null, homeInstance: string | null = null): User {
  return { id, username, displayName, avatar: null, createdAt: 1, homeInstance } as unknown as User;
}

const ME = user('me', 'jannis', 'Jannis');
const MIRA = user('mira', 'mira', 'Mira');
const OSKAR = user('oskar', 'oskar');
const TOVE = user('tove-local', 'tove@orbit.example', null, 'orbit.example');

function reaction(reactor: User | undefined, userId: string, at: number, emoji = '🎉'): Reaction {
  return { id: `r-${userId}-${at}`, messageId: 'm1', userId, emoji, createdAt: at, user: reactor };
}

const isMe = (r: Reaction) => r.userId === ME.id;
const nameOf = (r: Reaction) => r.user?.displayName ?? r.user?.username.split('@')[0] ?? 'Unknown';

function sentence(reactions: Reaction[]): string {
  return reactionSentence(summarizeReactors(reactions, isMe, nameOf), i18n.t, formatters).text;
}

function others(n: number, from = 0): Reaction[] {
  return Array.from({ length: n }, (_, i) => {
    const u = user(`u${from + i}`, `person${from + i}`);
    return reaction(u, u.id, 100 + from + i);
  });
}

afterEach(async () => {
  await setLanguage('en');
});

describe('summarizeReactors', () => {
  it('puts you first and keeps everyone else in the order they reacted', () => {
    const summary = summarizeReactors(
      [reaction(OSKAR, 'oskar', 1), reaction(MIRA, 'mira', 2), reaction(ME, 'me', 3)],
      isMe,
      nameOf,
    );
    expect(summary).toEqual({ includesYou: true, names: ['oskar', 'Mira'], others: 0, total: 3 });
  });

  it('names at most three people, you included, and counts the rest', () => {
    const summary = summarizeReactors([reaction(ME, 'me', 0), ...others(11)], isMe, nameOf);
    expect(summary.includesYou).toBe(true);
    expect(summary.names).toEqual(['person0', 'person1']);
    expect(summary.others).toBe(9);
    expect(summary.total).toBe(12);
  });

  it('counts a person once when the same user appears twice', () => {
    const summary = summarizeReactors([reaction(MIRA, 'mira', 1), reaction(MIRA, 'mira', 2)], isMe, nameOf);
    expect(summary.total).toBe(1);
    expect(summary.names).toEqual(['Mira']);
  });
});

describe('reactionSentence (en)', () => {
  it('one reactor, you', () => {
    expect(sentence([reaction(ME, 'me', 1)])).toBe('You reacted');
  });

  it('one reactor, someone else', () => {
    expect(sentence([reaction(MIRA, 'mira', 1)])).toBe('Mira reacted');
  });

  it('two reactors', () => {
    expect(sentence([reaction(MIRA, 'mira', 1), reaction(ME, 'me', 2)])).toBe('You and Mira reacted');
  });

  it('three reactors', () => {
    expect(sentence([reaction(ME, 'me', 1), reaction(MIRA, 'mira', 2), reaction(OSKAR, 'oskar', 3)]))
      .toBe('You, Mira, and oskar reacted');
  });

  it('twelve reactors', () => {
    expect(sentence([reaction(ME, 'me', 0), reaction(MIRA, 'mira', 1), ...others(10)]))
      .toBe('You, Mira, person0, and 9 others reacted');
  });

  it('four reactors leave one other', () => {
    expect(sentence([reaction(MIRA, 'mira', 1), ...others(3)]))
      .toBe('Mira, person0, person1, and 1 other reacted');
  });

  it('a remote user is named by display name or the name part of the handle', () => {
    expect(sentence([reaction(TOVE, TOVE.id, 1)])).toBe('tove reacted');
  });

  it('marks where the names are in the sentence', () => {
    const result = reactionSentence(
      summarizeReactors([reaction(ME, 'me', 1), reaction(MIRA, 'mira', 2)], isMe, nameOf),
      i18n.t,
      formatters,
    );
    expect(result.text.slice(result.namesStart, result.namesStart + result.namesLength)).toBe('You and Mira');
  });
});

describe('reactionSentence in every language', () => {
  const twelve = () => [reaction(ME, 'me', 0), reaction(MIRA, 'mira', 1), ...others(10)];

  it('de', async () => {
    await setLanguage('de');
    expect(sentence([reaction(ME, 'me', 1)])).toBe('Du hast reagiert');
    expect(sentence([reaction(MIRA, 'mira', 1)])).toBe('Mira hat reagiert');
    expect(sentence([reaction(ME, 'me', 0), reaction(MIRA, 'mira', 1)])).toBe('Du und Mira haben reagiert');
    expect(sentence(twelve())).toBe('Du, Mira, person0 und 9 weitere haben reagiert');
    expect(sentence([reaction(MIRA, 'mira', 1), ...others(3)])).toBe('Mira, person0, person1 und 1 weitere Person haben reagiert');
  });

  it('ru', async () => {
    await setLanguage('ru');
    expect(sentence([reaction(ME, 'me', 1)])).toBe('Вы отреагировали');
    expect(sentence([reaction(MIRA, 'mira', 1)])).toBe('Реакция: Mira');
    expect(sentence(twelve())).toBe('Вы, Mira, person0 и ещё 9 человек отреагировали');
    expect(sentence([reaction(MIRA, 'mira', 1), ...others(4)])).toBe('Mira, person0, person1 и ещё 2 человека отреагировали');
  });

  it('zh', async () => {
    await setLanguage('zh');
    expect(sentence([reaction(ME, 'me', 1)])).toBe('您做出了反应');
    expect(sentence([reaction(MIRA, 'mira', 1)])).toBe('Mira 做出了反应');
    expect(sentence(twelve())).toBe('您、Mira、person0和另外 9 人 做出了反应');
  });
});
