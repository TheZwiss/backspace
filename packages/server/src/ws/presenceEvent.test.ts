import { describe, it, expect } from 'vitest';
import { validateActivities } from './presenceEvent.js';

// One rule for a local client's activity_update and a peer's relayed
// presence: an activity the sender accepts must be one every receiver accepts.
describe('validateActivities', () => {
  it('accepts a named activity and trims its name', () => {
    expect(validateActivities([{ type: 'playing', name: '  Factorio ' }])).toEqual([{ type: 'playing', name: 'Factorio' }]);
  });

  it('refuses a name that is only whitespace', () => {
    expect(validateActivities([{ type: 'playing', name: '   ' }])).toBeNull();
  });

  it('refuses an empty name', () => {
    expect(validateActivities([{ type: 'playing', name: '' }])).toBeNull();
  });
});
