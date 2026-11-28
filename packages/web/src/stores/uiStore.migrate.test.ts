import { describe, it, expect } from 'vitest';
import { migrateUiSettings } from './uiStore';
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
} from '../utils/rightPanelResize';

// `backspace-ui-settings` persisted through v0 with the width stored under
// `memberListWidth` (space member list only). v1 renamed it to
// `rightPanelWidth` when the group-DM roster and the friends activity list
// joined the same resizable right column. The migration must carry the user's
// saved width across, clamped, and never wedge the layout on corrupt data.

describe('migrateUiSettings (persist schema for backspace-ui-settings)', () => {
  it('maps a v0 memberListWidth to rightPanelWidth and keeps every other field', () => {
    const out = migrateUiSettings(
      { memberListOpen: false, memberListWidth: 320, lastChannelPerSpace: { s1: 'c1' } },
      0,
    );
    expect(out).toEqual({ memberListOpen: false, rightPanelWidth: 320, lastChannelPerSpace: { s1: 'c1' } });
  });

  it('clamps a v0 width that sits outside the current bounds', () => {
    expect(migrateUiSettings({ memberListWidth: 99999 }, 0)).toEqual({ rightPanelWidth: RIGHT_PANEL_MAX_WIDTH });
    expect(migrateUiSettings({ memberListWidth: 0 }, 0)).toEqual({ rightPanelWidth: RIGHT_PANEL_MIN_WIDTH });
  });

  it('ignores a non-numeric v0 width so the store default applies instead', () => {
    // No rightPanelWidth in the result → the store initializer's default
    // (240) survives the merge; the corrupt key must not become NaN.
    expect(migrateUiSettings({ memberListWidth: 'wide' }, 0)).toEqual({ memberListWidth: 'wide' });
  });

  it('passes v1 payloads through untouched', () => {
    const state = { memberListOpen: true, rightPanelWidth: 300, lastChannelPerSpace: {} };
    expect(migrateUiSettings(state, 1)).toBe(state);
  });

  it('survives null and undefined payloads', () => {
    expect(migrateUiSettings(null, 0)).toEqual({});
    expect(migrateUiSettings(undefined, 1)).toEqual({});
  });

  it('defaults are coherent with what the migration clamps into', () => {
    expect(RIGHT_PANEL_DEFAULT_WIDTH).toBeGreaterThan(RIGHT_PANEL_MIN_WIDTH);
    expect(RIGHT_PANEL_DEFAULT_WIDTH).toBeLessThan(RIGHT_PANEL_MAX_WIDTH);
  });
});
