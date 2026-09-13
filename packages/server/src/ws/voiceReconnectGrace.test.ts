import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { connectionManager, VOICE_RECONNECT_GRACE_MS } from './handler.js';
import { handleClientEvent } from './events.js';

function socket(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

function joinSpace(userId: string, roomId: string, ws: WebSocket): void {
  connectionManager.createRoom(roomId, 'space', { type: 'space', spaceId: `space-${roomId}` });
  connectionManager.joinRoom(roomId, userId);
  connectionManager.addConnection(userId, ws);
  connectionManager.addConnection(userId, socket());
  connectionManager.setVoiceWs(userId, ws);
}

function close(ws: WebSocket): void {
  connectionManager.removeConnection(ws);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('voice reconnect grace', () => {
  it('keeps a space participant during the grace period', () => {
    const ws = socket();
    joinSpace('grace-space-user', 'grace-space-room', ws);

    close(ws);
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS - 1);

    expect(connectionManager.getRoomParticipants('grace-space-room')).toContain('grace-space-user');
    connectionManager.destroyRoom('grace-space-room');
  });

  it('rebinds within grace without a leave/join broadcast', () => {
    const oldWs = socket();
    const newWs = socket();
    joinSpace('grace-rebind-user', 'grace-rebind-room', oldWs);
    const sendSpy = vi.spyOn(connectionManager, 'sendToRoom');

    close(oldWs);
    connectionManager.addConnection('grace-rebind-user', newWs);
    connectionManager.setVoiceWs('grace-rebind-user', newWs);
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);

    expect(connectionManager.getRoomParticipants('grace-rebind-room')).toContain('grace-rebind-user');
    expect(sendSpy).not.toHaveBeenCalledWith('grace-rebind-room', expect.objectContaining({ type: 'voice_state_update' }));
    connectionManager.clearVoiceWs('grace-rebind-user');
    connectionManager.removeConnection(newWs);
    connectionManager.destroyRoom('grace-rebind-room');
  });

  it('finalizes a stale space voice session exactly once', () => {
    const ws = socket();
    joinSpace('grace-expire-user', 'grace-expire-room', ws);
    const sendSpy = vi.spyOn(connectionManager, 'sendToSpace');

    close(ws);
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS * 2);

    expect(connectionManager.getUserRoom('grace-expire-user')).toBeNull();
    expect(sendSpy.mock.calls.filter(([, event]) =>
      event.type === 'voice_state_update' && event.userId === 'grace-expire-user' && event.action === 'leave',
    )).toHaveLength(1);
  });

  it('does not end an active DM while its last participant is inside grace', () => {
    const ws = socket();
    connectionManager.createRoom('grace-dm-room', 'dm', { type: 'dm', callerId: 'grace-dm-user', state: 'active' });
    connectionManager.joinRoom('grace-dm-room', 'grace-dm-user');
    connectionManager.addConnection('grace-dm-user', ws);
    connectionManager.addConnection('grace-dm-user', socket());
    connectionManager.setVoiceWs('grace-dm-user', ws);

    close(ws);
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS - 1);

    expect(connectionManager.getRoom('grace-dm-room')).toBeDefined();
    expect(connectionManager.getRoomParticipants('grace-dm-room')).toContain('grace-dm-user');
    connectionManager.destroyRoom('grace-dm-room');
  });

  it('removes the last DM participant and ends the call after grace', () => {
    const ws = socket();
    connectionManager.createRoom('grace-dm-expire-room', 'dm', { type: 'dm', callerId: 'grace-dm-expire-user', state: 'active' });
    connectionManager.joinRoom('grace-dm-expire-room', 'grace-dm-expire-user');
    connectionManager.addConnection('grace-dm-expire-user', ws);
    connectionManager.addConnection('grace-dm-expire-user', socket());
    connectionManager.setVoiceWs('grace-dm-expire-user', ws);
    const sendSpy = vi.spyOn(connectionManager, 'sendToDmMembers');

    close(ws);
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);

    expect(connectionManager.getRoom('grace-dm-expire-room')).toBeUndefined();
    expect(sendSpy).toHaveBeenCalledWith('grace-dm-expire-room', {
      type: 'dm_call_ended', dmChannelId: 'grace-dm-expire-room',
    });
  });

  it('explicit leave remains immediate', () => {
    const ws = socket();
    joinSpace('grace-explicit-user', 'grace-explicit-room', ws);

    connectionManager.clearVoiceWs('grace-explicit-user');
    connectionManager.leaveCurrentRoom('grace-explicit-user');

    expect(connectionManager.getUserRoom('grace-explicit-user')).toBeNull();
    connectionManager.removeConnection(ws);
  });

  it('an ordinary second tab does not keep a stale voice session forever', () => {
    const voiceWs = socket();
    const ordinaryWs = socket();
    joinSpace('grace-tabs-user', 'grace-tabs-room', voiceWs);
    connectionManager.addConnection('grace-tabs-user', ordinaryWs);

    close(voiceWs);
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);

    expect(connectionManager.getUserRoom('grace-tabs-user')).toBeNull();
    connectionManager.removeConnection(ordinaryWs);
  });

  it('does not let voice_status from an ordinary tab resume a space session', () => {
    const voiceWs = socket();
    const ordinaryWs = socket();
    joinSpace('grace-status-tab-user', 'grace-status-tab-room', voiceWs);
    connectionManager.addConnection('grace-status-tab-user', ordinaryWs);

    close(voiceWs);
    handleClientEvent(
      { type: 'voice_status', isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false },
      'grace-status-tab-user',
      'grace-status-tab-user',
      ordinaryWs,
      false,
    );
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);

    expect(connectionManager.getUserRoom('grace-status-tab-user')).toBeNull();
    connectionManager.removeConnection(ordinaryWs);
  });

  it('rebinds an active DM through voice_status from the replacement socket', () => {
    const oldWs = socket();
    const newWs = socket();
    connectionManager.createRoom('grace-dm-rebind-room', 'dm', {
      type: 'dm', callerId: 'grace-dm-rebind-user', state: 'active',
    });
    connectionManager.joinRoom('grace-dm-rebind-room', 'grace-dm-rebind-user');
    connectionManager.addConnection('grace-dm-rebind-user', oldWs);
    connectionManager.setVoiceWs('grace-dm-rebind-user', oldWs);

    close(oldWs);
    connectionManager.addConnection('grace-dm-rebind-user', newWs);
    handleClientEvent(
      { type: 'voice_status', isMuted: true, isDeafened: false, isCameraOn: false, isScreenSharing: false },
      'grace-dm-rebind-user',
      'grace-dm-rebind-user',
      newWs,
      false,
    );
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);

    expect(connectionManager.getRoomParticipants('grace-dm-rebind-room')).toContain('grace-dm-rebind-user');
    expect(connectionManager.getVoiceWs('grace-dm-rebind-user')).toBe(newWs);
    connectionManager.clearVoiceWs('grace-dm-rebind-user');
    connectionManager.removeConnection(newWs);
    connectionManager.destroyRoom('grace-dm-rebind-room');
  });
});
