import { describe, it, expect, afterEach } from 'vitest';
import {
  bootTwoInstancesForHandshake,
  registerAdmin,
  initiatePeering,
  resetPeer,
  getPeer,
  s2sHealthy,
  simulateReset,
} from './helpers/realHandshake.js';
import type { TwoInstanceHarness } from './helpers/twoInstanceHarness.js';
import { openInspector } from './helpers/dbInspect.js';

/**
 * Acceptance-gate integration suite for the federation handshake desync bugs.
 *
 * These cases drive the REAL cross-instance `/peer/initiate`→`/peer/accept`
 * handshake (via realHandshake.ts) rather than seeding peer rows. This is the
 * RED baseline: #1 (control) passes on current code, #2 (BUG-1) and #4 (BUG-2)
 * are EXPECTED to fail against current (unfixed) code — the fixes in later tasks
 * turn them green. Do NOT modify product code to make #2/#4 pass here.
 */

let h: TwoInstanceHarness;
afterEach(async () => {
  if (h) await h.cleanup();
});

describe('federation handshake desync (BUG-1/BUG-2)', () => {
  it('#1 control: clean handshake activates both sides with matching secret', async () => {
    h = await bootTwoInstancesForHandshake();
    const adminI = await registerAdmin(h.home);
    await registerAdmin(h.remote);

    const { status } = await initiatePeering(h.home, adminI.token, h.remote);
    expect(status).toBe(200);

    expect(await s2sHealthy(h.home, h.remote)).toBe(true);
    expect(await s2sHealthy(h.remote, h.home)).toBe(true);

    const homeInsp = openInspector(h.home);
    const remoteInsp = openInspector(h.remote);
    try {
      const iSecret = homeInsp.federationPeer(h.remote.origin)?.hmacSecret;
      const rSecret = remoteInsp.federationPeer(h.home.origin)?.hmacSecret;
      expect(iSecret).toBeTruthy();
      expect(rSecret).toBeTruthy();
      expect(iSecret).toBe(rSecret);
    } finally {
      homeInsp.close();
      remoteInsp.close();
    }
  }, 60_000);

  it('#2 BUG-1: initiator must NOT false-activate against a survivor that holds a row', async () => {
    h = await bootTwoInstancesForHandshake();
    const adminI = await registerAdmin(h.home);
    await registerAdmin(h.remote);

    // Establish peering, then reset home (fresh incarnation, no row).
    // remote still holds its old active row for home's origin.
    await initiatePeering(h.home, adminI.token, h.remote);
    expect(await s2sHealthy(h.home, h.remote)).toBe(true);

    const freshHome = await simulateReset(h.home, h);
    const adminI2 = await registerAdmin(freshHome);

    // Fresh home re-initiates into the survivor remote (which still holds its old active row).
    const { status, body } = await initiatePeering(freshHome, adminI2.token, h.remote);

    // FIX (green): remote refuses honestly with 409; fresh home does NOT end up active-but-dead.
    expect(status).toBe(409);
    expect(body.code).toBe('PEER_EXISTS_RESET_REQUIRED');

    // Fresh home must hold no false-active row for remote's origin.
    const insp = openInspector(freshHome);
    try {
      const iRow = insp.federationPeer(h.remote.origin);
      expect(iRow?.status === 'active').toBe(false);
    } finally {
      insp.close();
    }
  }, 60_000);

  it('#4 BUG-2: one-click Re-peer never reports success on a dead peering; genuinely recovers', async () => {
    h = await bootTwoInstancesForHandshake();
    const adminI = await registerAdmin(h.home);
    const adminR = await registerAdmin(h.remote);

    await initiatePeering(h.home, adminI.token, h.remote);
    expect(await s2sHealthy(h.home, h.remote)).toBe(true);

    const freshHome = await simulateReset(h.home, h);
    const adminIf = await registerAdmin(freshHome);

    // Fresh home initiates into remote → triggers detection (remote's row moves to
    // needs_attention via markPeerReset). On buggy code fresh home ALSO false-activates;
    // after the fix fresh home gets 409 and stays clean.
    await initiatePeering(freshHome, adminIf.token, h.remote);

    // One-click Re-peer on the SURVIVOR (remote): detection must have fired.
    const rPeer = await getPeer(h.remote, adminR.token, freshHome.origin);
    expect(rPeer).toBeTruthy();
    expect(rPeer!.status).toBe('needs_attention');

    // Reset remote's stale row, then re-initiate the handshake from remote.
    await resetPeer(h.remote, adminR.token, rPeer!.id);
    const rebuilt = await initiatePeering(h.remote, adminR.token, freshHome);

    // GENUINE recovery: 200 + working secret in both directions + matching stored secrets.
    expect(rebuilt.status).toBe(200);
    expect(await s2sHealthy(h.remote, freshHome)).toBe(true);
    expect(await s2sHealthy(freshHome, h.remote)).toBe(true);

    const remoteInsp = openInspector(h.remote);
    const homeInsp = openInspector(freshHome);
    try {
      const rSecret = remoteInsp.federationPeer(freshHome.origin)?.hmacSecret;
      const iSecret = homeInsp.federationPeer(h.remote.origin)?.hmacSecret;
      expect(rSecret).toBeTruthy();
      expect(iSecret).toBeTruthy();
      expect(rSecret).toBe(iSecret);
    } finally {
      remoteInsp.close();
      homeInsp.close();
    }
  }, 60_000);
});
