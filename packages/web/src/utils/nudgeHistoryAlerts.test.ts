import { describe, expect, it, vi } from 'vitest';
import { messageAlertsUser } from './alerts';
import type { RealtimeMessageEvent } from '../stores/chatStore';
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
describe('passive attention history', () => {
 it.each(['shake', 'msn_fart_guy'])('never plays a second message alert for %s history', effect => {
  const event = { channelId: 'dm', message: { type: 'system', content: JSON.stringify({ event: 'nudge', effect }) } } as RealtimeMessageEvent;
  expect(messageAlertsUser(event)).toBe(false);
  expect(messageAlertsUser(event, { everyMessage: true })).toBe(false);
 });
});
