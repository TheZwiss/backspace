import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOUNDBOARD_SETTINGS, type SoundboardDocument } from '@backspace/shared/src/soundboard';
import { useAuthStore } from './authStore';
import { soundboardKey, useSoundboardStore } from './soundboardStore';

const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../utils/crossStoreResolvers', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/crossStoreResolvers')>(),
  getApiForOrigin: () => ({ soundboard: api }),
}));
const document = (maxSounds: number): SoundboardDocument => ({ settings: { ...DEFAULT_SOUNDBOARD_SETTINGS, maxSounds }, sounds: [] });
beforeEach(() => { vi.clearAllMocks(); useSoundboardStore.getState().reset(); useAuthStore.setState({ user: null }); });
describe('origin/account-scoped soundboard catalog', () => {
  it('keeps catalogs with equal space ids on different origins separate', async () => {
    api.list.mockResolvedValueOnce(document(10)).mockResolvedValueOnce(document(20));
    await useSoundboardStore.getState().load('', 'space');
    await useSoundboardStore.getState().load('https://remote.test', 'space');
    expect(useSoundboardStore.getState().entries[soundboardKey('', 'space')]?.document?.settings.maxSounds).toBe(10);
    expect(useSoundboardStore.getState().entries[soundboardKey('https://remote.test', 'space')]?.document?.settings.maxSounds).toBe(20);
  });
  it('never applies an older response after a newer refresh', async () => {
    let resolveOld!: (value: SoundboardDocument) => void;
    api.list.mockReturnValueOnce(new Promise<SoundboardDocument>(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(document(20));
    const first = useSoundboardStore.getState().load('', 'space');
    await useSoundboardStore.getState().load('', 'space');
    resolveOld(document(10)); await first;
    expect(useSoundboardStore.getState().entries[soundboardKey('', 'space')]?.document?.settings.maxSounds).toBe(20);
  });
  it('invalidates pending responses across reset, even if the same account requests the same key again', async () => {
    let resolveOld!: (value: SoundboardDocument) => void;
    api.list.mockReturnValueOnce(new Promise<SoundboardDocument>(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(document(20));
    const first = useSoundboardStore.getState().load('', 'space');
    useSoundboardStore.getState().reset();
    await useSoundboardStore.getState().load('', 'space');
    resolveOld(document(10)); await first;
    expect(useSoundboardStore.getState().entries[soundboardKey('', 'space')]?.document?.settings.maxSounds).toBe(20);
  });
  it('clears an actionable stale catalog when access is refused', async () => {
    api.list.mockResolvedValueOnce(document(10)).mockRejectedValueOnce(new Error('Forbidden'));
    await useSoundboardStore.getState().load('', 'space'); await useSoundboardStore.getState().load('', 'space');
    const entry = useSoundboardStore.getState().entries[soundboardKey('', 'space')];
    expect(entry?.document).toBeUndefined(); expect(entry?.error).toBeInstanceOf(Error);
  });
});
