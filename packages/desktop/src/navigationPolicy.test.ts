import { describe, it, expect } from 'vitest';
import { isNavigationAllowed } from './navigationPolicy';

const PICKER_URL = 'file:///Applications/Backspace.app/Contents/Resources/resources/instance-picker.html';

describe('isNavigationAllowed', () => {
  it('allows same-origin navigation (a normal in-app link/redirect)', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'https://chat.example.com/channels/123',
        currentUrl: 'https://chat.example.com/app',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(true);
  });

  it('allows navigation to the bundled file:// instance picker', () => {
    expect(
      isNavigationAllowed({
        targetUrl: PICKER_URL,
        currentUrl: null,
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(true);
  });

  it('denies navigation to a file:// URL that is not the picker', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'file:///etc/passwd',
        currentUrl: null,
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(false);
  });

  it('allows navigation to a known federation-peer origin', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'https://peer.example.org/join/abc123',
        currentUrl: 'https://chat.example.com/app',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(['https://peer.example.org']),
      })
    ).toBe(true);
  });

  it('denies navigation to a foreign http(s) origin not in the known set', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'https://evil.example.net/phish',
        currentUrl: 'https://chat.example.com/app',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(['https://peer.example.org']),
      })
    ).toBe(false);
  });

  it('denies a malformed target URL', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'not a url',
        currentUrl: 'https://chat.example.com/app',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(false);
  });

  it('denies a non-http(s)/file protocol (e.g. javascript:)', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'javascript:alert(1)',
        currentUrl: 'https://chat.example.com/app',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(false);
  });

  it('denies a foreign origin even when currentUrl is null/unknown', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'https://evil.example.net/phish',
        currentUrl: null,
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(false);
  });

  it('denies when currentUrl is malformed and target is not otherwise allowlisted', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'https://chat.example.com/app',
        currentUrl: 'not a url',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(false);
  });
});
