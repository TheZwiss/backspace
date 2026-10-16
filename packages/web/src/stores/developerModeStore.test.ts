import { beforeEach, describe, expect, it } from 'vitest';
import { useDeveloperModeStore } from './developerModeStore';

describe('developer mode store', () => {
  beforeEach(() => useDeveloperModeStore.getState().reset());

  it('is off until the server says otherwise', () => {
    expect(useDeveloperModeStore.getState().enabled).toBe(false);
  });

  it('mirrors the value it is given and forgets it on reset', () => {
    useDeveloperModeStore.getState().setEnabled(true);
    expect(useDeveloperModeStore.getState().enabled).toBe(true);
    useDeveloperModeStore.getState().reset();
    expect(useDeveloperModeStore.getState().enabled).toBe(false);
  });

  it('keeps nothing in the browser: the account owns the switch', () => {
    localStorage.clear();
    useDeveloperModeStore.getState().setEnabled(true);
    expect(localStorage.length).toBe(0);
  });
});
