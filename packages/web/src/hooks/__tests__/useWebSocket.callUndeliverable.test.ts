import { describe, it, expect } from 'vitest';
import { buildCallUndeliverableToast } from '../../utils/callUndeliverableToast.js';

describe('buildCallUndeliverableToast', () => {
  const fail = (overrides: Partial<{ reason: string; peerOrigin?: string; peerLabel?: string }> = {}) => ({
    reason: 'peer_transient_failure',
    peerLabel: 'nova',
    ...overrides,
  });

  it('start + terminal single failure: existing copy', () => {
    expect(buildCallUndeliverableToast([fail()], true, 'start')).toMatch(/Could not reach nova/);
  });

  it('start + non-terminal: "some participants" copy', () => {
    expect(buildCallUndeliverableToast([fail()], false, 'start')).toMatch(/Some participants could not be reached/);
  });

  it('accept + terminal: tear-down copy', () => {
    expect(buildCallUndeliverableToast([fail()], true, 'accept'))
      .toMatch(/Couldn't confirm your accept with nova/);
  });

  it('reject + non-terminal: info copy', () => {
    expect(buildCallUndeliverableToast([fail()], false, 'reject'))
      .toMatch(/Couldn't notify nova that you declined/);
  });

  it('end + non-terminal: info copy', () => {
    expect(buildCallUndeliverableToast([fail()], false, 'end'))
      .toMatch(/Couldn't notify nova that you hung up/);
  });

  it('legacy two-arg signature still works', () => {
    expect(buildCallUndeliverableToast([fail()], true)).toMatch(/Could not reach nova/);
  });

  it('builds warning copy for host_unreachable (peer_transient_failure)', () => {
    const msg = buildCallUndeliverableToast(
      [{ reason: 'peer_transient_failure', peerOrigin: 'https://orbit.local', peerLabel: 'Orbit' }],
      true,
      'host_unreachable',
    );
    expect(msg.toLowerCase()).toContain('orbit');
    expect(msg.toLowerCase()).toContain('unreachable');
  });

  it('builds warning copy for host_unreachable (peer_rejected)', () => {
    const msg = buildCallUndeliverableToast(
      [{ reason: 'peer_rejected', peerOrigin: 'https://orbit.local', peerLabel: 'Orbit' }],
      true,
      'host_unreachable',
    );
    expect(msg.toLowerCase()).toContain('orbit');
    expect(msg.toLowerCase()).toContain('peered');
  });

  it('renders no_recipient single-failure terminal copy', () => {
    const fail = (peerLabel = 'Orbit') => ({
      reason: 'no_recipient',
      peerOrigin: 'https://orbit.local',
      peerLabel,
    });
    expect(buildCallUndeliverableToast([fail()], true, 'start'))
      .toBe("Orbit couldn't ring anyone.");
  });

  it('no_recipient falls back to origin when peerLabel missing', () => {
    const fail = {
      reason: 'no_recipient',
      peerOrigin: 'https://orbit.local',
    };
    expect(buildCallUndeliverableToast([fail], true, 'start'))
      .toMatch(/orbit\.local couldn't ring anyone\./);
  });

  it('no_recipient in a multi-failure terminal falls back to multi-instance copy', () => {
    const failures = [
      { reason: 'no_recipient', peerOrigin: 'https://orbit.local', peerLabel: 'Orbit' },
      { reason: 'peer_transient_failure', peerOrigin: 'https://nova.local', peerLabel: 'Nova' },
    ];
    expect(buildCallUndeliverableToast(failures, true, 'start'))
      .toMatch(/Could not reach 2 instances: Orbit, Nova/);
  });

  it('no_recipient non-terminal uses the existing "Some participants" line', () => {
    const failures = [
      { reason: 'no_recipient', peerOrigin: 'https://orbit.local', peerLabel: 'Orbit' },
    ];
    expect(buildCallUndeliverableToast(failures, false, 'start'))
      .toMatch(/Some participants could not be reached: Orbit/);
  });
});
