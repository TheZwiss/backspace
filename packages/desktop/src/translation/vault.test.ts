import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { TranslationVault } from './vault';
import { TranslationError } from '@backspace/translation';

// Reversible test cipher only; production is wired exclusively to Electron safeStorage.
const encryption = {
  encrypt: (value: string) => Buffer.from(Buffer.from(value).toString('base64')),
  decrypt: (value: Buffer) => Buffer.from(value.toString(), 'base64').toString(),
};
const profile = {
  name: 'Private',
  protocol: 'openai-chat' as const,
  baseUrl: 'https://api.example/v1',
  model: 'test-model',
  apiKey: 'secret-for-tests',
};
const scope = 'https://chat.example\nalice';
let directory: string;
let vault: TranslationVault;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'backspace-vault-'));
  vault = new TranslationVault(directory, encryption);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('local encrypted credential vault', () => {
  it('never returns stored keys, encrypts disk data and isolates origin/account', () => {
    const settings = vault.saveConnection(scope, profile);
    expect(settings.connections[0]!.hasKey).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(profile.apiKey);
    const file = path.join(directory, readdirSync(directory)[0]!);
    expect(readFileSync(file).toString()).not.toContain(profile.apiKey);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new TranslationVault(directory, encryption).snapshot(scope)).toEqual(settings);
    expect(vault.snapshot('https://chat.example\nbob').connections).toEqual([]);
    expect(vault.snapshot('https://other.example\nalice').connections).toEqual([]);
  });
  it('retains, changes and explicitly clears a secret', () => {
    const id = vault.saveConnection(scope, profile).connections[0]!.id;
    vault.saveConnection(scope, {
      ...profile,
      id,
      apiKey: undefined,
      model: 'different',
    });
    expect(vault.read(scope).connections[0]!.apiKey).toBe(profile.apiKey);
    vault.saveConnection(scope, { ...profile, id, apiKey: 'new-secret' });
    expect(vault.read(scope).connections[0]!.apiKey).toBe('new-secret');
    vault.saveConnection(scope, { ...profile, id, apiKey: '' });
    expect(vault.snapshot(scope).connections[0]!.hasKey).toBe(false);
  });
  it('does not move a stored secret to an edited recipient', () => {
    const id = vault.saveConnection(scope, profile).connections[0]!.id;
    const changed = {
      ...profile,
      id,
      apiKey: undefined,
      baseUrl: 'https://other.example/v1',
    };
    expect(() => vault.saveConnection(scope, changed)).toThrow('invalid-input');
    expect(() => vault.saveConnection(scope, { ...changed, apiKey: 'new-key' })).not.toThrow();
  });
  it('requires consent and a selected engine for automation', () => {
    const settings = vault.snapshot(scope);
    expect(() =>
      vault.savePreferences(scope, {
        ...settings.preferences,
        automatic: true,
      }),
    ).toThrow('consent-required');
    expect(() =>
      vault.savePreferences(scope, {
        ...settings.preferences,
        consent: true,
        automatic: true,
      }),
    ).toThrow('missing-connection');
    expect(() =>
      vault.savePreferences(scope, {
        ...settings.preferences,
        engine: 'google-free',
        consent: true,
        automatic: true,
      }),
    ).not.toThrow();
  });
  it('deletion disables automation without selecting a different connection', () => {
    const first = vault.saveConnection(scope, profile).connections[0]!.id;
    const state = vault.saveConnection(scope, { ...profile, name: 'second' });
    vault.savePreferences(scope, {
      ...state.preferences,
      consent: true,
      automatic: true,
    });
    const result = vault.deleteConnection(scope, first);
    expect(result.preferences.defaultConnection).toBeNull();
    expect(result.preferences.automatic).toBe(false);
    expect(result.connections).toHaveLength(1);
  });
  it('fails visibly on corrupt ciphertext or unavailable secure storage', () => {
    vault.saveConnection(scope, profile);
    writeFileSync(path.join(directory, readdirSync(directory)[0]!), 'corrupt');
    expect(() => vault.read(scope)).toThrow('storage');
    const unavailable = new TranslationVault(directory, {
      ...encryption,
      encrypt: () => {
        throw new TranslationError('secure-storage');
      },
    });
    expect(() => unavailable.saveConnection('new-scope', profile)).toThrow('secure-storage');
  });
});
