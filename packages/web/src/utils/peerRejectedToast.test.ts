import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import enFederation from '../locales/en/federation.json';
import deFederation from '../locales/de/federation.json';
import type { FederationPeerStatusReason } from '@backspace/shared';

const holder = vi.hoisted(() => ({ i18n: null as I18n | null }));
vi.mock('../i18n', () => ({
  default: { t: (...args: Parameters<I18n['t']>) => holder.i18n!.t(...args) },
}));

beforeAll(async () => {
  holder.i18n = createInstance();
  await holder.i18n.init({
    lng: 'de',
    fallbackLng: 'en',
    defaultNS: 'federation',
    ns: ['federation'],
    resources: { en: { federation: enFederation }, de: { federation: deFederation } },
  });
});

const CODES: FederationPeerStatusReason[] = [
  'auth_failures', 'peer_reset_detected', 'repeer_incomplete', 'denied_by_local_admin',
  'denied_by_remote', 'revoked_by_remote', 'expired_on_remote', 'stale_peering_on_remote',
];

describe('peerRejectedToast', () => {
  it.each(CODES)('reads %s from the catalog in the selected language, naming the peer', async (code) => {
    const { peerRejectedToast } = await import('./peerRejectedToast');
    const text = peerRejectedToast({ peerOrigin: 'https://orbit.example', peerLabel: 'Orbit', reason: 'x', reasonCode: code });
    expect(text).toBe(deFederation.peerRejected[code].replace('{{name}}', 'Orbit'));
  });

  it('falls back to the server text when an older server sends no code', async () => {
    const { peerRejectedToast } = await import('./peerRejectedToast');
    const text = peerRejectedToast({ peerOrigin: 'https://orbit.example', reason: 'Remote instance requires manual peering approval' });
    expect(text).toContain('orbit.example');
    expect(text).toContain('Remote instance requires manual peering approval');
  });

  it('falls back to the server text for a code this client does not know', async () => {
    const { peerRejectedToast } = await import('./peerRejectedToast');
    const text = peerRejectedToast({
      peerOrigin: 'https://orbit.example',
      peerLabel: 'Orbit',
      reason: 'A reason a newer server added',
      // The event arrives as JSON: nothing on the wire stops a code this union lacks.
      reasonCode: 'some_future_reason' as FederationPeerStatusReason,
    });
    expect(text).toBe(deFederation.peerRejected.fallback
      .replace('{{name}}', 'Orbit')
      .replace('{{reason}}', 'A reason a newer server added'));
  });
});
