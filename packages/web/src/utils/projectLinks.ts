/**
 * Every outbound project URL the web client links to, and the builders that
 * derive URLs from them.
 *
 * Only the web client reads these, so they live here and not in `shared`,
 * which holds contracts between packages. Links always point upstream: the
 * Backspace page is about the project. The instance's own source offer (a
 * fork's `BACKSPACE_SOURCE_URL`) comes from `GET /api/instance/info`, never
 * from here.
 *
 * `funding` and `community` ship as null. A null value hides its card, so no
 * card ever renders a dead link; filling one in is a one-line change here.
 * `projectLinks.test.ts` runs `projectLinksProblems` over the real constant,
 * so a malformed value fails CI rather than shipping.
 */

export interface CommunityTarget {
  /** Canonical origin of the community instance, e.g. "https://chat.example.org". */
  origin: string;
  /** Id of the community space on that instance. */
  spaceId: string;
}

export interface ProjectLinks {
  repository: string;
  insights: string;
  /** README heading "Installation". */
  installGuide: string;
  releases: string;
  license: string;
  security: string;
  contributors: string;
  /** Ko-fi page; null until it exists. */
  funding: string | null;
  /** The community space; null until the instance exists. */
  community: CommunityTarget | null;
}

const REPOSITORY = 'https://github.com/TheZwiss/backspace';

export const PROJECT_LINKS: ProjectLinks = {
  repository: REPOSITORY,
  insights: 'https://backspacechat.com/insights/',
  installGuide: `${REPOSITORY}#installation`,
  releases: `${REPOSITORY}/releases`,
  license: `${REPOSITORY}/blob/main/LICENSE`,
  security: `${REPOSITORY}/blob/main/SECURITY.md`,
  contributors: `${REPOSITORY}/graphs/contributors`,
  funding: null,
  community: null,
};

/** Release tags are `v1.5.1` form; only a plain three-part version has one. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The release page for `version`, or the release list when the version has no
 * upstream tag: a fork's label, a `-dev` suffix, an empty string or unknown.
 */
export function releaseNotesUrl(version: string | null): string {
  if (version !== null && RELEASE_VERSION.test(version)) {
    return `${PROJECT_LINKS.repository}/releases/tag/v${version}`;
  }
  return PROJECT_LINKS.releases;
}

/**
 * A new bug report on the upstream issue form, prefilled.
 *
 * `version` and `environment` are the ids of two `input` fields in
 * `.github/ISSUE_TEMPLATE/bug_report.yml`; GitHub issue forms prefill `input`
 * and `textarea` fields from query parameters named after the field id.
 * Renaming either id there silently stops the prefill here.
 */
export function bugReportUrl(fields: { version: string | null; environment: string }): string {
  const params = new URLSearchParams({ template: 'bug_report.yml' });
  if (fields.version !== null) params.set('version', fields.version);
  params.set('environment', fields.environment);
  return `${PROJECT_LINKS.repository}/issues/new?${params.toString()}`;
}

/** A new feature request on the upstream issue form. */
export function featureRequestUrl(): string {
  return `${PROJECT_LINKS.repository}/issues/new?template=feature_request.yml`;
}

/** Null when `value` parses as an `https:` URL, otherwise why it does not. */
function httpsProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'does not parse as a URL';
  }
  return url.protocol === 'https:' ? null : 'is not https';
}

/**
 * What is wrong with `links`, one entry per offending field, each starting
 * with the field's name. Empty means well formed: every non-null URL parses
 * and is `https:`, and `community.origin` is a bare origin (no path, no
 * trailing slash) paired with a non-empty `spaceId`.
 */
export function projectLinksProblems(links: ProjectLinks): string[] {
  const problems: string[] = [];
  const urls: Array<[keyof ProjectLinks, string | null]> = [
    ['repository', links.repository],
    ['insights', links.insights],
    ['installGuide', links.installGuide],
    ['releases', links.releases],
    ['license', links.license],
    ['security', links.security],
    ['contributors', links.contributors],
    ['funding', links.funding],
  ];
  for (const [field, value] of urls) {
    if (value === null) continue;
    const problem = httpsProblem(value);
    if (problem !== null) problems.push(`${field} ${problem}`);
  }

  if (links.community !== null) {
    const { origin, spaceId } = links.community;
    const problem = httpsProblem(origin);
    if (problem !== null) {
      problems.push(`community.origin ${problem}`);
    } else if (new URL(origin).origin !== origin) {
      problems.push('community.origin is not a bare origin (no path, no trailing slash)');
    }
    if (spaceId.trim() === '') problems.push('community.spaceId is empty');
  }

  return problems;
}
