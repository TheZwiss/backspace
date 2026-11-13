import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAttentionMutes, attentionMuted, ATTENTION_MUTE_DURATIONS } from './attentionMutes';
const bob = { id: 'bob', username: 'bob', homeInstance: null, homeUserId: null };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); useAttentionMutes.setState({ entries: [] }); });
afterEach(() => vi.useRealTimers());
describe('attention mutes', () => {
 it('mutes only the chosen person for the selected account', () => {
  useAttentionMutes.getState().mute('alice', bob, '', 900_000);
  expect(attentionMuted('alice', bob, '')).toBe(true);
  expect(attentionMuted('another-account', bob, '')).toBe(false);
  expect(attentionMuted('alice', { id: 'charlie' }, '')).toBe(false);
 });
 it('expires automatically at the exact deadline', () => {
  useAttentionMutes.getState().mute('alice', bob, '', ATTENTION_MUTE_DURATIONS[0]);
  vi.advanceTimersByTime(899_999); expect(attentionMuted('alice', bob, '')).toBe(true);
  vi.advanceTimersByTime(1); expect(attentionMuted('alice', bob, '')).toBe(false);
 });
 it('supports an indefinite mute and manual unmute', () => {
  useAttentionMutes.getState().mute('alice', bob, '', null);
  vi.advanceTimersByTime(365 * 24 * 3600_000); expect(attentionMuted('alice', bob, '')).toBe(true);
  const entry = useAttentionMutes.getState().entries[0]!;
  useAttentionMutes.getState().unmute('alice', entry.key); expect(attentionMuted('alice', bob, '')).toBe(false);
 });
 it('matches another replica of the same person without colliding with other instances', () => {
  useAttentionMutes.getState().mute('alice', { ...bob, homeUserId: 'home-bob', homeInstance: 'bob.example' }, '', null);
  expect(attentionMuted('alice', { id: 'replica', homeUserId: 'home-bob', homeInstance: 'bob.example' }, 'https://remote.example')).toBe(true);
  expect(attentionMuted('alice', bob, 'https://another.example')).toBe(false);
  expect(attentionMuted('alice', bob, '')).toBe(true);
 });
 it('rejects invalid durations and persists the chosen deadline', () => {
  useAttentionMutes.getState().mute('alice', bob, '', -1); expect(useAttentionMutes.getState().entries).toHaveLength(0);
  useAttentionMutes.getState().mute('alice', bob, '', 3600_000);
  expect(JSON.parse(localStorage.getItem('backspace-attention-mutes')!).state.entries[0].until).toBe(3700_000);
 });
});
