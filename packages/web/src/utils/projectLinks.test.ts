import { describe, it, expect } from 'vitest';
import {
  PROJECT_LINKS,
  projectLinksProblems,
  releaseNotesUrl,
  bugReportUrl,
  featureRequestUrl,
  type ProjectLinks,
} from './projectLinks';

const REPO = 'https://github.com/TheZwiss/backspace';

/** A well-formed set with both optional targets filled, for the validator's sample cases. */
function filled(over: Partial<ProjectLinks> = {}): ProjectLinks {
  return {
    ...PROJECT_LINKS,
    funding: 'https://ko-fi.com/example',
    community: { origin: 'https://chat.example.org', spaceId: 'space-1' },
    ...over,
  };
}

describe('PROJECT_LINKS', () => {
  it('holds the upstream repository and the paths derived from it', () => {
    expect(PROJECT_LINKS).toEqual({
      repository: REPO,
      insights: 'https://backspacechat.com/insights/',
      installGuide: `${REPO}#installation`,
      releases: `${REPO}/releases`,
      license: `${REPO}/blob/main/LICENSE`,
      security: `${REPO}/blob/main/SECURITY.md`,
      contributors: `${REPO}/graphs/contributors`,
      funding: 'https://ko-fi.com/backspacechat',
      community: null,
    });
  });

  // Runs against the real constant, so a malformed value filled in later
  // fails CI instead of shipping a dead card.
  it('is well formed', () => {
    expect(projectLinksProblems(PROJECT_LINKS)).toEqual([]);
  });
});

describe('projectLinksProblems', () => {
  it('accepts filled funding and community targets', () => {
    expect(projectLinksProblems(filled())).toEqual([]);
  });

  it('names a funding URL that is not https', () => {
    expect(projectLinksProblems(filled({ funding: 'http://ko-fi.com/example' }))).toEqual([
      expect.stringContaining('funding'),
    ]);
  });

  it('names a funding value that does not parse', () => {
    expect(projectLinksProblems(filled({ funding: 'ko-fi.com/example' }))).toEqual([
      expect.stringContaining('funding'),
    ]);
  });

  it('names a required link that is not https', () => {
    expect(projectLinksProblems(filled({ insights: 'http://backspacechat.com/insights/' }))).toEqual([
      expect.stringContaining('insights'),
    ]);
  });

  it('names a community origin with a path', () => {
    const links = filled({ community: { origin: 'https://chat.example.org/app', spaceId: 'space-1' } });
    expect(projectLinksProblems(links)).toEqual([expect.stringContaining('community.origin')]);
  });

  it('names a community origin with a trailing slash', () => {
    const links = filled({ community: { origin: 'https://chat.example.org/', spaceId: 'space-1' } });
    expect(projectLinksProblems(links)).toEqual([expect.stringContaining('community.origin')]);
  });

  it('names a community origin that is not https', () => {
    const links = filled({ community: { origin: 'http://chat.example.org', spaceId: 'space-1' } });
    expect(projectLinksProblems(links)).toEqual([expect.stringContaining('community.origin')]);
  });

  it('names an empty community space id', () => {
    const links = filled({ community: { origin: 'https://chat.example.org', spaceId: '' } });
    expect(projectLinksProblems(links)).toEqual([expect.stringContaining('community.spaceId')]);
  });

  it('names a whitespace-only community space id', () => {
    const links = filled({ community: { origin: 'https://chat.example.org', spaceId: '   ' } });
    expect(projectLinksProblems(links)).toEqual([expect.stringContaining('community.spaceId')]);
  });

  it('reports every problem, not just the first', () => {
    const links = filled({
      funding: 'http://ko-fi.com/example',
      community: { origin: 'https://chat.example.org/', spaceId: '' },
    });
    expect(projectLinksProblems(links)).toHaveLength(3);
  });
});

describe('releaseNotesUrl', () => {
  it('links a release version to its tag', () => {
    expect(releaseNotesUrl('1.5.1')).toBe(`${REPO}/releases/tag/v1.5.1`);
  });

  it.each([
    ['a -dev suffix', '1.5.1-dev'],
    ['a fork label', 'custom'],
    ['an empty string', ''],
    ['a leading v', 'v1.5.1'],
    ['two components', '1.5'],
  ])('links %s to the release list', (_label, version) => {
    expect(releaseNotesUrl(version)).toBe(`${REPO}/releases`);
  });

  it('links an unknown version to the release list', () => {
    expect(releaseNotesUrl(null)).toBe(`${REPO}/releases`);
  });
});

describe('bugReportUrl', () => {
  it('opens the bug form prefilled with version and environment', () => {
    const url = new URL(bugReportUrl({ version: '1.5.1', environment: 'Firefox 131 on macOS' }));
    expect(`${url.origin}${url.pathname}`).toBe(`${REPO}/issues/new`);
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('version')).toBe('1.5.1');
    expect(url.searchParams.get('environment')).toBe('Firefox 131 on macOS');
  });

  it('omits the version when it is unknown', () => {
    const url = new URL(bugReportUrl({ version: null, environment: 'Chrome 140 on Windows' }));
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.has('version')).toBe(false);
    expect(url.searchParams.get('environment')).toBe('Chrome 140 on Windows');
  });

  it('encodes characters that would otherwise break the query', () => {
    const environment = 'Desktop app (Chrome 146) on macOS & more #1';
    const url = new URL(bugReportUrl({ version: '1.5.1', environment }));
    expect(url.hash).toBe('');
    expect(url.searchParams.get('environment')).toBe(environment);
  });
});

describe('featureRequestUrl', () => {
  it('opens the feature request form', () => {
    expect(featureRequestUrl()).toBe(`${REPO}/issues/new?template=feature_request.yml`);
  });
});
