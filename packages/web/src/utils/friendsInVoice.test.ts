import { describe, expect, it } from 'vitest';
import { groupFriendsInVoice } from './friendsInVoice';
import type { TaggedFriend } from '../stores/socialStore';
import type { TaggedSpace } from '../stores/spaceStore';
const friend = (id: string, origin = '') => ({ id, username: id, _instanceOrigin: origin }) as TaggedFriend;
const spaces = [{ id: 's', name: 'Server', _instanceOrigin: '' }] as TaggedSpace[];
const index = new Map([['v', { spaceId: 's', origin: '', type: 'voice' as const, name: 'Lounge' }]]);
describe('friends in voice', () => {
 it('groups only friends and removes duplicate presence entries', () => {
  const groups = groupFriendsInVoice([friend('alice')], new Map([['v', ['alice', 'stranger', 'alice']]]), index, spaces);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.channelName).toBe('Lounge');
  expect(groups[0]?.friends.map(f => f.id)).toEqual(['alice']);
 });
 it('does not expose unknown channels, DMs, or friends from a different origin with the same ID', () => {
  expect(groupFriendsInVoice([friend('alice', 'https://other.example')], new Map([['v', ['alice']], ['dm', ['alice']]]), index, spaces)).toEqual([]);
 });
 it('uses alternative instance rows of the same friend', () => {
  const alice = friend('remote-id', 'https://other.example'); alice._rows = [alice, friend('local-id')];
  expect(groupFriendsInVoice([alice], new Map([['v', ['local-id']]]), index, spaces)[0]?.friends).toEqual([alice]);
 });
 it('removes groups immediately when the last friend disconnects', () => {
  expect(groupFriendsInVoice([friend('alice')], new Map([['v', ['stranger']]]), index, spaces)).toEqual([]);
 });
});
