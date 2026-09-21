import { describe, it, expect } from 'vitest';
import { documentHash, rowHash } from './hash';
import type { ValidDocument, ValidSpace } from './validate';

const HEX_64 = /^[0-9a-f]{64}$/;

function space(over: Partial<ValidSpace> = {}): ValidSpace {
  return {
    id: 'a',
    name: 'Alpha',
    description: 'first',
    icon: null,
    banner: null,
    avatarColor: 'mint',
    visibility: 'public',
    memberCount: 3,
    createdAt: 1_000,
    ...over,
  };
}

function doc(spaces: ValidSpace[], over: Partial<Omit<ValidDocument, 'spaces'>> = {}): ValidDocument {
  return { instanceName: 'Test', federatedRegistrationOpen: true, version: '1.4.0', spaces, ...over };
}

describe('rowHash', () => {
  it('is 64 lowercase hex characters', async () => {
    expect(await rowHash(space())).toMatch(HEX_64);
  });

  it('ignores the key order of the input object', async () => {
    // The same fields written in reverse order; the type is the same, the
    // insertion order (and so a naive JSON.stringify) is not.
    const reversed: ValidSpace = {
      createdAt: 1_000,
      memberCount: 3,
      visibility: 'public',
      avatarColor: 'mint',
      banner: null,
      icon: null,
      description: 'first',
      name: 'Alpha',
      id: 'a',
    };
    expect(await rowHash(reversed)).toBe(await rowHash(space()));
  });

  it('changes when any field changes', async () => {
    const base = await rowHash(space());
    expect(await rowHash(space({ memberCount: 4 }))).not.toBe(base);
    expect(await rowHash(space({ description: null }))).not.toBe(base);
    expect(await rowHash(space({ avatarColor: null }))).not.toBe(base);
    expect(await rowHash(space({ visibility: 'request' }))).not.toBe(base);
  });
});

describe('documentHash', () => {
  it('is 64 lowercase hex characters', async () => {
    expect(await documentHash(doc([space()]))).toMatch(HEX_64);
  });

  it('is the same for the same document in a different spaces order and key order', async () => {
    const a = space({ id: 'a' });
    const b = space({ id: 'b', name: 'Beta', memberCount: 9 });
    const bReversed: ValidSpace = {
      createdAt: b.createdAt,
      memberCount: b.memberCount,
      visibility: b.visibility,
      avatarColor: b.avatarColor,
      banner: b.banner,
      icon: b.icon,
      description: b.description,
      name: b.name,
      id: b.id,
    };
    const one = doc([a, b]);
    const two: ValidDocument = { spaces: [bReversed, a], version: '1.4.0', federatedRegistrationOpen: true, instanceName: 'Test' };
    expect(await documentHash(two)).toBe(await documentHash(one));
  });

  it('changes when one memberCount changes, along with that row hash and no other', async () => {
    const a = space({ id: 'a' });
    const b = space({ id: 'b', name: 'Beta' });
    const c = space({ id: 'c', name: 'Gamma' });
    const before = doc([a, b, c]);
    const bChanged = space({ id: 'b', name: 'Beta', memberCount: 99 });
    const after = doc([a, bChanged, c]);

    expect(await documentHash(after)).not.toBe(await documentHash(before));
    expect(await rowHash(bChanged)).not.toBe(await rowHash(b));
    expect(await rowHash(a)).toBe(await rowHash(a));
    expect(await rowHash(c)).toBe(await rowHash(c));
    // The unchanged rows hash the same whether they sit in the old or the new document.
    const rowsBefore = await Promise.all(before.spaces.map(rowHash));
    const rowsAfter = await Promise.all(after.spaces.map(rowHash));
    expect(rowsAfter[0]).toBe(rowsBefore[0]);
    expect(rowsAfter[1]).not.toBe(rowsBefore[1]);
    expect(rowsAfter[2]).toBe(rowsBefore[2]);
  });

  it('changes when an instance field changes', async () => {
    const base = await documentHash(doc([space()]));
    expect(await documentHash(doc([space()], { instanceName: 'Other' }))).not.toBe(base);
    expect(await documentHash(doc([space()], { federatedRegistrationOpen: false }))).not.toBe(base);
    expect(await documentHash(doc([space()], { version: null }))).not.toBe(base);
  });

  it('changes when a space is added or removed', async () => {
    const base = await documentHash(doc([space()]));
    expect(await documentHash(doc([]))).not.toBe(base);
    expect(await documentHash(doc([space(), space({ id: 'b' })]))).not.toBe(base);
  });
});
