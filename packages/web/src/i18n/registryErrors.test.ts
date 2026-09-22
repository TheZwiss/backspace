import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { describeRegistryError, registryReason } from './registryErrors';

let i18n: I18n;

beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({
    lng: 'de',
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common', 'federation'],
    resources: {
      en: {
        common: {},
        federation: {
          connections: { row: { reason: {
            unreachable: 'This instance could not be reached.',
            sessionExpired: 'The saved session expired. Re-authenticate to reconnect.',
            reauthenticate: 'Re-authenticate to connect.',
            authenticateHome: 'Authenticate to connect to your home instance.',
          } } },
        },
      },
      de: {
        common: {},
        federation: {
          connections: { row: { reason: {
            unreachable: 'Diese Instanz war nicht erreichbar.',
            sessionExpired: 'Die gespeicherte Sitzung ist abgelaufen. Melde dich erneut an, um die Verbindung wiederherzustellen.',
            reauthenticate: 'Melde dich erneut an, um zu verbinden.',
            authenticateHome: 'Melde dich an, um dich mit deiner Heimatinstanz zu verbinden.',
          } } },
        },
      },
    },
  });
});

function t() {
  return i18n.getFixedT(null, ['federation', 'common']);
}

describe('describeRegistryError', () => {
  it('has words in the reader\'s language for every reason the store writes', () => {
    expect(describeRegistryError(t(), registryReason('unreachable'))).toBe('Diese Instanz war nicht erreichbar.');
    expect(describeRegistryError(t(), registryReason('session_expired'))).toBe(
      'Die gespeicherte Sitzung ist abgelaufen. Melde dich erneut an, um die Verbindung wiederherzustellen.',
    );
    expect(describeRegistryError(t(), registryReason('reauthenticate'))).toBe('Melde dich erneut an, um zu verbinden.');
    expect(describeRegistryError(t(), registryReason('authenticate_home'))).toBe(
      'Melde dich an, um dich mit deiner Heimatinstanz zu verbinden.',
    );
  });

  it('never shows the code itself', () => {
    for (const reason of ['unreachable', 'session_expired', 'reauthenticate', 'authenticate_home'] as const) {
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
