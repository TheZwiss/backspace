import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { putHandle, getHandle, deleteHandle, clearAllHandles, supportsFsHandles, supportsDnDHandles } from './idbHandles';

describe('idbHandles', () => {
  beforeEach(async () => { await clearAllHandles(); });

  it('round-trips a structured-cloneable handle stand-in', async () => {
    const fakeHandle = { kind: 'file', name: 'photo.png' } as unknown as FileSystemHandle;
    await putHandle('t-1', fakeHandle);
    const read = await getHandle('t-1');
    expect(read).toEqual(fakeHandle);
  });

  it('returns undefined for missing key', async () => {
    expect(await getHandle('t-missing')).toBeUndefined();
  });

  it('deletes a stored handle', async () => {
    await putHandle('t-2', { kind: 'file' } as unknown as FileSystemHandle);
    await deleteHandle('t-2');
    expect(await getHandle('t-2')).toBeUndefined();
  });

  it('deleteHandle on a missing key is a no-op (no throw)', async () => {
    await expect(deleteHandle('t-never')).resolves.toBeUndefined();
  });

  it('clearAllHandles empties the store', async () => {
    await putHandle('t-3', { kind: 'file' } as unknown as FileSystemHandle);
    await putHandle('t-4', { kind: 'file' } as unknown as FileSystemHandle);
    await clearAllHandles();
    expect(await getHandle('t-3')).toBeUndefined();
    expect(await getHandle('t-4')).toBeUndefined();
  });

  it('supportsFsHandles returns a boolean', () => {
    expect(typeof supportsFsHandles()).toBe('boolean');
  });

  it('supportsDnDHandles returns a boolean', () => {
    expect(typeof supportsDnDHandles()).toBe('boolean');
  });
});
