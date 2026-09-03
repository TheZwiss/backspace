import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from 'electron';
import {
  classifyDesignatedRequirement,
  macAppBundlePath,
  getUpdateCapability,
  resetUpdateCapabilityForTest,
} from './updateCapability';

// The module reads app.isPackaged. Mock it so the capability branches are
// reachable in a plain Node test run, matching recovery.test.ts's pattern.
vi.mock('electron', () => ({
  app: { isPackaged: true },
}));

const mockedApp = app as unknown as { isPackaged: boolean };

function withPlatform(value: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('classifyDesignatedRequirement', () => {
  it('classifies a bare cdhash requirement as ad-hoc', () => {
    // Verbatim output from the ad-hoc signed 1.0.3 build that could not update.
    const output = [
      'Executable=/Applications/Backspace.app/Contents/MacOS/Backspace',
      '# designated => cdhash H"4a9e49fe20f82802702a4e9d752748e990909659"',
      '',
    ].join('\n');
    expect(classifyDesignatedRequirement(output)).toBe('adhoc');
  });

  it('classifies a universal binary with one cdhash per slice as ad-hoc', () => {
    const output = [
      'Executable=/Applications/Backspace.app/Contents/MacOS/Backspace',
      '# designated => cdhash H"aaaa1111" or cdhash H"bbbb2222"',
    ].join('\n');
    expect(classifyDesignatedRequirement(output)).toBe('adhoc');
  });

  it('classifies a Developer ID requirement as identified', () => {
    const output = [
      'Executable=/Applications/Backspace.app/Contents/MacOS/Backspace',
      'Identifier=com.backspace.desktop',
      '# designated => identifier "com.backspace.desktop" and anchor apple generic and certificate leaf[subject.OU] = "AB12CD34EF"',
    ].join('\n');
    expect(classifyDesignatedRequirement(output)).toBe('identified');
  });

  it('classifies a requirement wrapped across lines as identified', () => {
    const output = [
      'Executable=/Applications/Backspace.app/Contents/MacOS/Backspace',
      '# designated => identifier "com.backspace.desktop" and anchor apple',
      '  generic and certificate leaf[subject.OU] = "AB12CD34EF"',
      '',
    ].join('\n');
    expect(classifyDesignatedRequirement(output)).toBe('identified');
  });

  it('does not let a following codesign field leak into the requirement', () => {
    // A cdhash requirement followed by another field must still read as ad-hoc,
    // not get upgraded by the word "certificate" appearing further down.
    const output = [
      '# designated => cdhash H"4a9e49fe"',
      'CandidateCDHashFull=sha256=4a9e49fe',
      'CDHash=4a9e49fe',
      'certificate stuff that is not part of the requirement',
    ].join('\n');
    expect(classifyDesignatedRequirement(output)).toBe('adhoc');
  });

  it('classifies a real Developer ID requirement with no comment prefix', () => {
    // Verbatim from a shipping notarized app. Note there is no leading '#', and
    // the requirement carries certificate field terms as well as the anchor.
    const output =
      'Executable=/Applications/Discord.app/Contents/MacOS/Discord\n' +
      'designated => identifier "com.hnc.Discord" and anchor apple generic and ' +
      'certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate ' +
      'leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate ' +
      'leaf[subject.OU] = "53Q6R32WPB"\n';
    expect(classifyDesignatedRequirement(output)).toBe('identified');
  });

  it('handles the real stream ordering, where the requirement precedes Executable=', () => {
    // codesign writes the requirement to stdout and the -d report to stderr.
    // readDesignatedRequirement concatenates stdout then stderr, so the
    // Executable= field lands *after* the requirement and must terminate it.
    const stdout = '# designated => cdhash H"4a9e49fe20f82802702a4e9d752748e990909659"\n';
    const stderr = 'Executable=/Applications/Backspace.app/Contents/MacOS/Backspace\n';
    expect(classifyDesignatedRequirement(`${stdout}\n${stderr}`)).toBe('adhoc');
  });

  it('classifies an unsigned bundle as unknown', () => {
    // codesign prints this to stderr and never emits a designated requirement.
    const output = '/Applications/Backspace.app: code object is not signed at all\n';
    expect(classifyDesignatedRequirement(output)).toBe('unknown');
  });

  it('classifies empty output as unknown', () => {
    expect(classifyDesignatedRequirement('')).toBe('unknown');
  });

  it('classifies a truncated requirement line as unknown', () => {
    expect(classifyDesignatedRequirement('# designated => \n')).toBe('unknown');
  });

  it('classifies an unrecognised requirement shape as unknown', () => {
    expect(classifyDesignatedRequirement('# designated => info[Something] = "x"')).toBe('unknown');
  });
});

describe('macAppBundlePath', () => {
  it('resolves the bundle root from the main executable', () => {
    expect(macAppBundlePath('/Applications/Backspace.app/Contents/MacOS/Backspace'))
      .toBe('/Applications/Backspace.app');
  });

  it('handles a bundle in a path containing spaces', () => {
    expect(macAppBundlePath('/Users/x/My Apps/Backspace.app/Contents/MacOS/Backspace'))
      .toBe('/Users/x/My Apps/Backspace.app');
  });
});

describe('getUpdateCapability', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetUpdateCapabilityForTest();
    mockedApp.isPackaged = true;
  });

  it('is external inside Flatpak', () => {
    vi.stubEnv('FLATPAK_ID', 'io.github.TheZwiss.backspace');
    withPlatform('linux', () => {
      expect(getUpdateCapability()).toBe('external');
    });
  });

  it('is manual for an unpackaged dev build on every platform', () => {
    mockedApp.isPackaged = false;
    withPlatform('win32', () => {
      expect(getUpdateCapability()).toBe('manual');
    });
  });

  it('is auto on Windows, where NSIS applies unsigned updates', () => {
    withPlatform('win32', () => {
      expect(getUpdateCapability()).toBe('auto');
    });
  });

  it('is auto on Linux, where AppImage applies unsigned updates', () => {
    withPlatform('linux', () => {
      expect(getUpdateCapability()).toBe('auto');
    });
  });

  it('memoises the result so codesign runs at most once', () => {
    withPlatform('win32', () => {
      const first = getUpdateCapability();
      mockedApp.isPackaged = false; // would flip the answer if it were re-read
      expect(getUpdateCapability()).toBe(first);
    });
  });
});
