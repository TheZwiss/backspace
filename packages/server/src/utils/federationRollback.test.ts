import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerPermanentFailureCallback,
  invokePermanentFailureCallback,
  _resetCallbacks,
} from './federationRollback.js';

describe('permanent-failure callback registry', () => {
  beforeEach(() => _resetCallbacks());

  it('invokes the registered callback when called by eventType', () => {
    const cb = vi.fn();
    registerPermanentFailureCallback('friend_request_create', cb);
    invokePermanentFailureCallback('friend_request_create', 'msg-123', 'recipient_not_found');
    expect(cb).toHaveBeenCalledWith('msg-123', 'recipient_not_found');
  });

  it('is a no-op for unregistered event types', () => {
    expect(() =>
      invokePermanentFailureCallback('unknown_event_type', 'msg-1', 'whatever')
    ).not.toThrow();
  });

  it('replaces a previously-registered callback for the same eventType', () => {
    const old = vi.fn();
    const fresh = vi.fn();
    registerPermanentFailureCallback('e1', old);
    registerPermanentFailureCallback('e1', fresh);
    invokePermanentFailureCallback('e1', 'msg-9', 'reason');
    expect(old).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledWith('msg-9', 'reason');
  });

  it('swallows errors thrown by the callback (logs but does not throw)', () => {
    registerPermanentFailureCallback('boom', () => { throw new Error('test'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => invokePermanentFailureCallback('boom', 'msg-x', 'r')).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
