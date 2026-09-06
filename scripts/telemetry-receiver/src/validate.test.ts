import { describe, it, expect } from 'vitest';
import { parsePing, roundTwoSignificant, normaliseCountry, MAX_BODY_BYTES } from './validate';

// The full schema 1 payload from section 5 of the spec, plus one unknown field.
// Keeping every field here is what makes a missing entry in COUNT_FIELDS visible.
const good = {
  schema: 1, instance: '3f6c9e2a-1b2c-4d5e-8f90-1234567890ab', day: '2026-09-06',
  build: { version: '1.1.2', commit: '0a1c465', modified: false },
  users: { registered: 12345, active1d: 7, active7d: 19, active30d: 31 },
  clients: { web: 12, desktop: 6, mobile: 1 },
  content: { spaces: 3, channels: 21, messages: 12345, messages7d: 410, storageMiB: 700 },
  features: { voice: true, federation: true, peers: 2, registrationOpen: false },
  runtime: { install: null, os: 'linux', arch: 'arm64', node: 20 },
  installedAt: '2026-07',
  extra: { future: 'field' },
};

describe('parsePing', () => {
  it('accepts a valid ping and rounds counts on arrival', () => {
    const r = parsePing(JSON.stringify(good), '2026-09-06');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ping).toMatchObject({ instance: good.instance, day: '2026-09-06', schema: 1 });
    const body = JSON.parse(r.ping.body) as typeof good;
    expect(body.users.registered).toBe(12000);
    expect(body.content.messages).toBe(12000);
    expect(body.users.active1d).toBe(7);
    expect(body.extra).toEqual({ future: 'field' });
  });
  it('leaves the non-numeric schema 1 fields untouched', () => {
    const r = parsePing(JSON.stringify(good), '2026-09-06');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = JSON.parse(r.ping.body) as typeof good;
    expect(body.build).toEqual({ version: '1.1.2', commit: '0a1c465', modified: false });
    expect(body.runtime).toEqual({ install: null, os: 'linux', arch: 'arm64', node: 20 });
    expect(body.features).toEqual({ voice: true, federation: true, peers: 2, registrationOpen: false });
    expect(body.installedAt).toBe('2026-07');
  });
  it('validates runtime.node like every other schema 1 count', () => {
    const bad = (node: unknown) => parsePing(JSON.stringify({ ...good, runtime: { ...good.runtime, node } }), '2026-09-06');
    expect(bad('twenty').ok).toBe(false);
    expect(bad(-1).ok).toBe(false);
    expect(bad(20.5).ok).toBe(false);
    const r = bad(20);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((JSON.parse(r.ping.body) as typeof good).runtime.node).toBe(20);
  });
  it('rejects malformed JSON, wrong schema, bad ids, bad days', () => {
    expect(parsePing('{', '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, schema: 0 }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, schema: '1' }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, instance: 'not-a-uuid' }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, day: '2026-9-6' }), '2026-09-06').ok).toBe(false);
  });
  it('rejects days more than two days from the receiver date', () => {
    expect(parsePing(JSON.stringify({ ...good, day: '2026-09-04' }), '2026-09-06').ok).toBe(true);
    expect(parsePing(JSON.stringify({ ...good, day: '2026-09-03' }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, day: '2026-09-09' }), '2026-09-06').ok).toBe(false);
  });
  it('rejects a day that does not exist and a receiver date it cannot place', () => {
    // Date.parse rolls 2026-02-30 over into March, which would otherwise land
    // inside the drift window and store a row keyed on a day that never was.
    expect(parsePing(JSON.stringify({ ...good, day: '2026-02-30' }), '2026-03-01').ok).toBe(false);
    expect(parsePing(JSON.stringify(good), 'not-a-day').ok).toBe(false);
  });
  it('rejects negative, fractional, oversized or non-numeric known counts', () => {
    expect(parsePing(JSON.stringify({ ...good, users: { ...good.users, registered: -1 } }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, users: { ...good.users, registered: 1.5 } }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, users: { ...good.users, registered: 1e12 } }), '2026-09-06').ok).toBe(false);
    expect(parsePing(JSON.stringify({ ...good, users: { ...good.users, registered: '5' } }), '2026-09-06').ok).toBe(false);
  });
  it('rejects bodies over the size limit', () => {
    const big = JSON.stringify({ ...good, pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect(parsePing(big, '2026-09-06').ok).toBe(false);
  });
  // build.version is the one free text field that reaches the public archive:
  // the collector tallies it and folds it into a published dimension. Bound it
  // here so nothing longer or stranger than a version string is ever stored.
  it('bounds build.version and keeps it optional', () => {
    const withVersion = (version: unknown) =>
      parsePing(JSON.stringify({ ...good, build: { ...good.build, version } }), '2026-09-06');
    expect(withVersion('1.1.2').ok).toBe(true);
    expect(withVersion('1.2.0-rc.1').ok).toBe(true);
    expect(withVersion('x'.repeat(32)).ok).toBe(true);
    expect(withVersion('x'.repeat(33)).ok).toBe(false);
    expect(withVersion('1.1.2 <script>').ok).toBe(false);
    expect(withVersion('').ok).toBe(false);
    expect(withVersion(2).ok).toBe(false);
    // Absent stays allowed: the field is optional in schema 1, and a build
    // without a version reports the rest of its payload as usual.
    const { build, ...noBuild } = good;
    expect(parsePing(JSON.stringify(noBuild), '2026-09-06').ok).toBe(true);
    expect(parsePing(JSON.stringify({ ...good, build: { commit: '0a1c465' } }), '2026-09-06').ok).toBe(true);
  });
  // The id the server mints is crypto.randomUUID(), always v4. A v1 id carries
  // the minting machine's MAC address, which is exactly the kind of thing this
  // endpoint must never accept, let alone store for ninety days.
  it('accepts a v4 id and rejects other UUID versions', () => {
    const withId = (instance: string) => parsePing(JSON.stringify({ ...good, instance }), '2026-09-06');
    expect(withId('3f6c9e2a-1b2c-4d5e-8f90-1234567890ab').ok).toBe(true);
    expect(withId('3f6c9e2a-1b2c-1d5e-8f90-1234567890ab').ok).toBe(false);
    expect(withId('3f6c9e2a-1b2c-5d5e-8f90-1234567890ab').ok).toBe(false);
  });
});

describe('roundTwoSignificant', () => {
  it('matches the server rule', () => {
    expect(roundTwoSignificant(99)).toBe(99);
    expect(roundTwoSignificant(12345)).toBe(12000);
    expect(roundTwoSignificant(999)).toBe(1000);
  });
  // The cases pinned here are the ones packages/server/src/telemetry/rounding.test.ts
  // pins as well. Both sides must agree or a rounded count changes on arrival.
  it('agrees with the server on the shared cases', () => {
    expect(roundTwoSignificant(0)).toBe(0);
    expect(roundTwoSignificant(7)).toBe(7);
    expect(roundTwoSignificant(99)).toBe(99);
    expect(roundTwoSignificant(150)).toBe(150);
    expect(roundTwoSignificant(999)).toBe(1000);
    expect(roundTwoSignificant(1234)).toBe(1200);
    expect(roundTwoSignificant(12500)).toBe(13000);
  });
});

describe('normaliseCountry', () => {
  it('maps unknowns to ZZ and keeps ISO codes', () => {
    expect(normaliseCountry('DE')).toBe('DE');
    expect(normaliseCountry('XX')).toBe('ZZ');
    expect(normaliseCountry('T1')).toBe('ZZ');
    expect(normaliseCountry(undefined)).toBe('ZZ');
    expect(normaliseCountry(null)).toBe('ZZ');
    expect(normaliseCountry('Germany')).toBe('ZZ');
  });
});
