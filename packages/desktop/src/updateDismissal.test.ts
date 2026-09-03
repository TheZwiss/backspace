import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseDismissalFile,
  loadDismissedVersion,
  setDismissedVersion,
  isVersionDismissed,
} from './updateDismissal';

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-userdata' },
}));

describe('parseDismissalFile', () => {
  it('reads a stored version', () => {
    expect(parseDismissalFile('{"dismissedVersion":"1.0.4"}')).toBe('1.0.4');
  });

  it('trims surrounding whitespace', () => {
    expect(parseDismissalFile('{"dismissedVersion":"  1.0.4  "}')).toBe('1.0.4');
  });

  it('returns null for invalid JSON rather than throwing', () => {
    expect(parseDismissalFile('{"dismissedVersion":')).toBeNull();
    expect(parseDismissalFile('')).toBeNull();
    expect(parseDismissalFile('not json at all')).toBeNull();
  });

  it('returns null when the field is missing or the wrong type', () => {
    expect(parseDismissalFile('{}')).toBeNull();
    expect(parseDismissalFile('{"dismissedVersion":null}')).toBeNull();
    expect(parseDismissalFile('{"dismissedVersion":104}')).toBeNull();
    expect(parseDismissalFile('{"dismissedVersion":["1.0.4"]}')).toBeNull();
  });

  it('returns null for a JSON value that is not an object', () => {
    expect(parseDismissalFile('"1.0.4"')).toBeNull();
    expect(parseDismissalFile('[1,2,3]')).toBeNull();
    expect(parseDismissalFile('null')).toBeNull();
  });

  it('rejects an empty or absurdly long version', () => {
    expect(parseDismissalFile('{"dismissedVersion":""}')).toBeNull();
    expect(parseDismissalFile('{"dismissedVersion":"   "}')).toBeNull();
    expect(parseDismissalFile(JSON.stringify({ dismissedVersion: 'x'.repeat(65) }))).toBeNull();
  });
});

describe('isVersionDismissed', () => {
  it('hides exactly the dismissed version', () => {
    expect(isVersionDismissed('1.0.4', '1.0.4')).toBe(true);
  });

  it('does not hide a later release', () => {
    expect(isVersionDismissed('1.0.5', '1.0.4')).toBe(false);
    expect(isVersionDismissed('2.0.0', '1.0.4')).toBe(false);
  });

  it('does not hide anything when nothing was dismissed', () => {
    expect(isVersionDismissed('1.0.4', null)).toBe(false);
  });
});

describe('dismissal round-trip on disk', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-update-'));
    file = path.join(dir, 'update-state.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists and reads back a version', () => {
    setDismissedVersion('1.0.4', file);
    expect(loadDismissedVersion(file)).toBe('1.0.4');
  });

  it('overwrites the previous dismissal rather than accumulating', () => {
    setDismissedVersion('1.0.4', file);
    setDismissedVersion('1.0.5', file);
    expect(loadDismissedVersion(file)).toBe('1.0.5');
  });

  it('returns null when the file does not exist', () => {
    expect(loadDismissedVersion(path.join(dir, 'absent.json'))).toBeNull();
  });

  it('returns null for a corrupt file instead of throwing', () => {
    fs.writeFileSync(file, '{"dismissedVersion": "1.0.4"');
    expect(loadDismissedVersion(file)).toBeNull();
  });

  it('clamps an over-long version on write', () => {
    setDismissedVersion('x'.repeat(200), file);
    // Written clamped to 64, which parseDismissalFile then accepts.
    expect(loadDismissedVersion(file)).toBe('x'.repeat(64));
  });

  it('ignores an empty version rather than writing one', () => {
    setDismissedVersion('   ', file);
    expect(fs.existsSync(file)).toBe(false);
  });
});
