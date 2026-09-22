import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import enFederation from '../locales/en/federation.json';
import deFederation from '../locales/de/federation.json';
import { describeRegistryError, registryReason, type RegistryErrorReason } from './registryErrors';

let i18n: I18n;

/**
 * The real catalogs, not a copy of the four sentences.
 *
 * A fixture that restates the English and German here passes forever against
 * text the app stopped showing the moment somebody reworded a key, and the
 * i18n check cannot see the mismatch either: it compares languages to each
 * other, not a test to the catalog. Loading the files means a renamed key
 * fails this test and a reworded one cannot drift from it.
 */
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({
    lng: 'de',
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common', 'federation'],
    resources: {
      en: { common: {}, federation: enFederation },
      de: { common: {}, federation: deFederation },
    },
  });
});

function t() {
  return i18n.getFixedT(null, ['federation', 'common']);
}

/** The reason codes the store writes, against the catalog key each one reads. */
const REASONS: ReadonlyArray<[RegistryErrorReason, keyof typeof enFederation.connections.row.reason]> = [
  ['unreachable', 'unreachable'],
  ['session_expired', 'sessionExpired'],
  ['reauthenticate', 'reauthenticate'],
  ['authenticate_home', 'authenticateHome'],
];

describe('describeRegistryError', () => {
  it('reads every reason the store writes out of the catalog', () => {
    for (const [reason, key] of REASONS) {
      expect(describeRegistryError(t(), registryReason(reason))).toBe(deFederation.connections.row.reason[key]);
    }
  });

  it('says them in the reader\'s language, not in the source language', () => {
    for (const [reason, key] of REASONS) {
      const shown = describeRegistryError(t(), reason);
      expect(shown).not.toBe(enFederation.connections.row.reason[key]);
      expect(shown.length).toBeGreaterThan(0);
    }
  });

  it('never shows the code itself', () => {
    for (const [reason] of REASONS) {
      expect(describeRegistryError(t(), reason)).not.toContain('_');
      expect(describeRegistryError(t(), reason)).not.toBe(reason);
    }
  });

  it('passes a value it does not know through unchanged', () => {
    // A registry row synced from a client on an older version carries the
    // English sentence that version wrote; it is the only explanation the row
    // has, so it is shown rather than dropped.
    expect(describeRegistryError(t(), 'Token expired')).toBe('Token expired');
    expect(describeRegistryError(t(), '')).toBe('');
  });
});
