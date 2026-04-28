import { describe, it, expect } from 'vitest';
import { inviteStatus, generateInviteToken } from './inviteService.js';

describe('inviteStatus', () => {
  const base = { revokedAt: null, expiresAt: null, maxUses: null, usedCount: 0 };

  it('returns active for a fresh invite', () => {
    expect(inviteStatus(base)).toBe('active');
  });

  it('returns revoked when revokedAt is set', () => {
    expect(inviteStatus({ ...base, revokedAt: 100 })).toBe('revoked');
  });

  it('returns expired when expiresAt is past', () => {
    expect(inviteStatus({ ...base, expiresAt: Date.now() - 1000 })).toBe('expired');
  });

  it('returns active when expiresAt is future', () => {
    expect(inviteStatus({ ...base, expiresAt: Date.now() + 100_000 })).toBe('active');
  });

  it('returns exhausted when usedCount >= maxUses', () => {
    expect(inviteStatus({ ...base, maxUses: 5, usedCount: 5 })).toBe('exhausted');
    expect(inviteStatus({ ...base, maxUses: 5, usedCount: 6 })).toBe('exhausted');
  });

  it('returns active when usedCount < maxUses', () => {
    expect(inviteStatus({ ...base, maxUses: 5, usedCount: 4 })).toBe('active');
  });

  it('revoked beats expired', () => {
    expect(inviteStatus({ ...base, revokedAt: 100, expiresAt: Date.now() - 1000 })).toBe('revoked');
  });

  it('expired beats exhausted', () => {
    expect(inviteStatus({ ...base, expiresAt: Date.now() - 1000, maxUses: 5, usedCount: 5 })).toBe('expired');
  });

  it('treats maxUses null as unlimited', () => {
    expect(inviteStatus({ ...base, maxUses: null, usedCount: 1_000_000 })).toBe('active');
  });
});

describe('generateInviteToken', () => {
  it('returns 22-char base64url string', () => {
    const t = generateInviteToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('returns different tokens on subsequent calls', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
  });
});
