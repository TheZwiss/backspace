import { describe, it, expect } from 'vitest';
import { friendRequestTarget } from './friendRequestTarget';

describe('friendRequestTarget', () => {
  it('names a replicated user by its home identity, with its handle for older servers', () => {
    expect(friendRequestTarget(
      { id: 'stub-1', username: 'yoko@orbit.test', homeUserId: 'yoko-home', homeInstance: 'orbit.test' },
      '',
    )).toEqual({ username: 'yoko@orbit.test', homeUserId: 'yoko-home', homeInstance: 'orbit.test' });
  });

  it('names a stub whose username is <homeUserId>@<domain> by identity, not by that name alone', () => {
    expect(friendRequestTarget(
      { id: 'stub-2', username: '342939417492520960@orbit.test', homeUserId: '342939417492520960', homeInstance: 'orbit.test' },
      '',
    )).toEqual({
      username: '342939417492520960@orbit.test',
      homeUserId: '342939417492520960',
      homeInstance: 'orbit.test',
    });
  });

  it('reduces a full-origin homeInstance to its host', () => {
    expect(friendRequestTarget(
      { id: 'stub-3', username: 'yoko@orbit.test', homeUserId: 'yoko-home', homeInstance: 'https://orbit.test' },
      '',
    )).toEqual({ username: 'yoko@orbit.test', homeUserId: 'yoko-home', homeInstance: 'orbit.test' });
  });

  it('names a user native to the remote instance it was loaded from by its id there', () => {
    expect(friendRequestTarget(
      { id: 'alice-id', username: 'alice', homeUserId: null, homeInstance: null },
      'https://orbit.test',
    )).toEqual({ username: 'alice@orbit.test', homeUserId: 'alice-id', homeInstance: 'orbit.test' });
  });

  it('names a native user of the home instance by username', () => {
    expect(friendRequestTarget(
      { id: 'bob-id', username: 'bob', homeUserId: null, homeInstance: null },
      '',
    )).toEqual({ username: 'bob' });
  });

  it('falls back to the username for a replicated row that carries no home id', () => {
    expect(friendRequestTarget(
      { id: 'stub-4', username: 'old@orbit.test', homeUserId: null, homeInstance: 'orbit.test' },
      '',
    )).toEqual({ username: 'old@orbit.test' });
  });
});
