import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TranslationCommand,
  TranslationReply,
  TranslationSettings,
} from '@backspace/shared/translation';
const auth = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: auth }));
import {
  acceptTranslationSettings,
  enqueueTranslation,
  loadTranslationSettings,
  resetTranslationScope,
  resumeAutomaticTranslation,
  useTranslationStore,
} from './translationStore';
const settings: TranslationSettings = {
  revision: 1,
  connections: [],
  preferences: {
    defaultConnection: null,
    engine: 'google-free',
    targetLanguage: 'zh-CN',
    automatic: true,
    consent: true,
    showOriginal: true,
  },
};
const success: TranslationReply = {
  ok: true,
  result: { kind: 'translated', text: '你好' },
};
const bridge = vi.fn<(command: TranslationCommand) => Promise<TranslationReply>>();
const task = (key: string) => ({
  key,
  text: 'Hello ' + key,
  scope: 'alice',
  accountId: 'alice',
  revision: 1,
  automatic: true,
});
beforeEach(() => {
  resetTranslationScope('alice');
  acceptTranslationSettings(settings);
  bridge.mockReset().mockResolvedValue(success);
  Object.defineProperty(window, 'backspace', {
    configurable: true,
    value: { translation: { command: bridge } },
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
});
afterEach(() => {
  resetTranslationScope('');
  delete window.backspace;
});

describe('local translation queue and cache', () => {
  it('serialises requests, deduplicates entries and cancels unsent rows', async () => {
    let finish!: (reply: TranslationReply) => void;
    bridge.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    enqueueTranslation(task('one'));
    enqueueTranslation(task('one'));
    const cancel = enqueueTranslation(task('two'));
    cancel();
    enqueueTranslation(task('three'));
    expect(bridge).toHaveBeenCalledTimes(1);
    finish(success);
    await vi.waitFor(() => expect(bridge).toHaveBeenCalledTimes(2));
    expect(bridge.mock.calls[1][0]).toMatchObject({ text: 'Hello three' });
    expect(useTranslationStore.getState().entries.two).toBeUndefined();
  });
  it('pauses automatic translation on failure until explicitly resumed', async () => {
    bridge.mockResolvedValueOnce({ ok: false, code: 'http', status: 429 });
    enqueueTranslation(task('one'));
    enqueueTranslation(task('two'));
    await vi.waitFor(() => expect(useTranslationStore.getState().automaticError?.code).toBe('http'));
    expect(bridge).toHaveBeenCalledTimes(1);
    enqueueTranslation(task('one'));
    expect(bridge).toHaveBeenCalledTimes(1);
    resumeAutomaticTranslation();
    enqueueTranslation(task('one'));
    await vi.waitFor(() => expect(bridge).toHaveBeenCalledTimes(2));
  });
  it('does not send automatic requests in a hidden window', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    enqueueTranslation(task('one'));
    expect(bridge).not.toHaveBeenCalled();
  });
  it('lets a user retry manually after an automatic failure', async () => {
    bridge.mockResolvedValueOnce({ ok: false, code: 'network' });
    enqueueTranslation(task('one'));
    await vi.waitFor(() => expect(useTranslationStore.getState().entries.one.state).toBe('error'));
    enqueueTranslation({ ...task('one'), automatic: false });
    await vi.waitFor(() => expect(useTranslationStore.getState().entries.one.state).toBe('done'));
    expect(bridge).toHaveBeenCalledTimes(2);
  });
  it('keeps completed translations for display-only settings without rebilling', async () => {
    enqueueTranslation(task('one'));
    await vi.waitFor(() => expect(useTranslationStore.getState().entries.one.state).toBe('done'));
    const generation = useTranslationStore.getState().generation;
    acceptTranslationSettings({
      ...settings,
      revision: 2,
      preferences: { ...settings.preferences, showOriginal: false },
    });
    enqueueTranslation({ ...task('one'), revision: 2 });
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(useTranslationStore.getState().generation).toBe(generation);
    acceptTranslationSettings({
      ...settings,
      revision: 3,
      preferences: { ...settings.preferences, targetLanguage: 'ja' },
    });
    expect(useTranslationStore.getState().entries).toEqual({});
  });
  it('rejects stale results even after switching A → B → A', async () => {
    let finish!: (reply: TranslationReply) => void;
    bridge.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    enqueueTranslation(task('old'));
    resetTranslationScope('bob');
    resetTranslationScope('alice');
    acceptTranslationSettings(settings);
    finish(success);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useTranslationStore.getState().entries).toEqual({});
  });
  it('rejects stale load replies after switching A → B → A', async () => {
    const completions: ((reply: TranslationReply) => void)[] = [];
    bridge.mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
    resetTranslationScope('');
    const first = loadTranslationSettings({
      scope: 'alice',
      accountId: 'alice',
    });
    const second = loadTranslationSettings({ scope: 'bob', accountId: 'bob' });
    const third = loadTranslationSettings({
      scope: 'alice',
      accountId: 'alice',
    });
    completions[2]({ ok: true, settings: { ...settings, revision: 3 } });
    await third;
    completions[0]({ ok: true, settings });
    completions[1]({ ok: false, code: 'storage' });
    await Promise.all([first, second]);
    expect(useTranslationStore.getState().settings?.revision).toBe(3);
    expect(useTranslationStore.getState().loadError).toBeNull();
  });
  it('clears message content immediately on logout', () => {
    useTranslationStore.setState({
      entries: {
        secret: {
          state: 'done',
          result: { kind: 'translated', text: 'private' },
          automatic: false,
        },
      },
    });
    auth.subscribe.mock.calls[0][0]({ user: null }, { user: { id: 'alice' } });
    expect(useTranslationStore.getState().entries).toEqual({});
    expect(useTranslationStore.getState().scope).toBe('');
  });
});

describe('effective translation configuration', () => {
  const connection = {
    id: 'ai',
    name: 'Primary',
    protocol: 'openai-chat' as const,
    baseUrl: 'https://api.example/v1',
    model: 'model',
    hasKey: true,
  };
  it('preserves results after key rotation, rename, unrelated connection edits and overridden defaults', async () => {
    acceptTranslationSettings({
      ...settings,
      connections: [connection],
      preferences: {
        ...settings.preferences,
        engine: 'ai',
        defaultConnection: 'ai',
      },
    });
    enqueueTranslation(task('one'));
    await vi.waitFor(() => expect(useTranslationStore.getState().entries.one.state).toBe('done'));
    const generation = useTranslationStore.getState().generation;
    acceptTranslationSettings({
      ...settings,
      revision: 2,
      connections: [
        { ...connection, name: 'Renamed', hasKey: false },
        { ...connection, id: 'other', model: 'other' },
      ],
      preferences: { ...settings.preferences, engine: 'ai', defaultConnection: 'other' },
    });
    expect(useTranslationStore.getState().entries.one.state).toBe('done');
    expect(useTranslationStore.getState().generation).toBe(generation);
    expect(bridge).toHaveBeenCalledTimes(1);
  });
  it('invalidates visible results when the actual model or consent changes', async () => {
    acceptTranslationSettings({
      ...settings,
      connections: [connection],
      preferences: {
        ...settings.preferences,
        engine: 'ai',
      },
    });
    enqueueTranslation(task('one'));
    await vi.waitFor(() => expect(useTranslationStore.getState().entries.one.state).toBe('done'));
    acceptTranslationSettings({
      ...settings,
      connections: [{ ...connection, model: 'different' }],
      preferences: {
        ...settings.preferences,
        engine: 'ai',
      },
    });
    expect(useTranslationStore.getState().entries).toEqual({});
    useTranslationStore.setState({ trackedMessages: { one: true } });
    acceptTranslationSettings({
      ...settings,
      preferences: { ...settings.preferences, consent: false, automatic: false },
    });
    expect(useTranslationStore.getState().trackedMessages).toEqual({});
  });
  it('pauses background refresh after an error without enabling global auto or retrying', async () => {
    acceptTranslationSettings({ ...settings, preferences: { ...settings.preferences, automatic: false } });
    bridge.mockResolvedValueOnce({ ok: false, code: 'http', status: 429 });
    enqueueTranslation({ ...task('one'), automatic: false, background: true });
    await vi.waitFor(() => expect(useTranslationStore.getState().automaticError?.code).toBe('http'));
    enqueueTranslation({ ...task('one'), automatic: false, background: true });
    expect(bridge).toHaveBeenCalledTimes(1);
    enqueueTranslation({ ...task('one'), automatic: false });
    await vi.waitFor(() => expect(useTranslationStore.getState().entries.one.state).toBe('done'));
    expect(bridge).toHaveBeenCalledTimes(2);
  });
});
