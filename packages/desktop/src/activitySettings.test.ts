import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import { parseActivitySettingsUpdate } from './activitySettings';

describe('parseActivitySettingsUpdate', () => {
  it('accepts a boolean enablePreemption', () => {
    expect(parseActivitySettingsUpdate({ enablePreemption: true })).toEqual({ enablePreemption: true });
    expect(parseActivitySettingsUpdate({ enablePreemption: false })).toEqual({ enablePreemption: false });
  });

  it('drops unknown keys and wrong types', () => {
    expect(parseActivitySettingsUpdate({ enablePreemption: 'yes' })).toBeNull();
    expect(parseActivitySettingsUpdate({ evil: 1 })).toBeNull();
    expect(parseActivitySettingsUpdate({ enablePreemption: true, evil: 1 })).toEqual({ enablePreemption: true });
  });

  it('rejects non-objects', () => {
    expect(parseActivitySettingsUpdate(null)).toBeNull();
    expect(parseActivitySettingsUpdate('x')).toBeNull();
    expect(parseActivitySettingsUpdate([true])).toBeNull();
    expect(parseActivitySettingsUpdate(undefined)).toBeNull();
  });
});
