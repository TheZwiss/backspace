import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildDesktopDownloads,
  detectDesktopPlatform,
  RELEASES_URL,
  type DesktopDownload,
  type DetectedPlatform,
} from '../../../platform/desktopDownload';

/** The primary offer, one variant per platform and architecture it can name. */
type PrimaryVariant = 'windows' | 'macArm64' | 'macX64' | 'linuxX64' | 'linuxArm64';

/** Every build a release carries, named by platform, architecture and file kind. */
type BuildVariant =
  | 'windows'
  | 'macArm64'
  | 'macX64'
  | 'linuxAppImageX64'
  | 'linuxAppImageArm64'
  | 'linuxDebX64'
  | 'linuxDebArm64';

// The keys are spelled out rather than built from the download, so the typed
// `t` checks every one of them and a renamed key fails the build.
const PRIMARY_LABEL_KEYS = {
  windows: 'desktopDownload.primary.windows',
  macArm64: 'desktopDownload.primary.macArm64',
  macX64: 'desktopDownload.primary.macX64',
  linuxX64: 'desktopDownload.primary.linuxX64',
  linuxArm64: 'desktopDownload.primary.linuxArm64',
} as const satisfies Record<PrimaryVariant, string>;

const BUILD_LABEL_KEYS = {
  windows: 'desktopDownload.build.windows',
  macArm64: 'desktopDownload.build.macArm64',
  macX64: 'desktopDownload.build.macX64',
  linuxAppImageX64: 'desktopDownload.build.linuxAppImageX64',
  linuxAppImageArm64: 'desktopDownload.build.linuxAppImageArm64',
  linuxDebX64: 'desktopDownload.build.linuxDebX64',
  linuxDebArm64: 'desktopDownload.build.linuxDebArm64',
} as const satisfies Record<BuildVariant, string>;

/**
 * The Windows installer covers both architectures and carries no `arch`, which
 * is why its variant never names one. For mac and linux a missing architecture
 * falls to the platform default, the same one the link builder picks.
 */
function primaryVariant(download: DesktopDownload): PrimaryVariant {
  switch (download.os) {
    case 'windows':
      return 'windows';
    case 'mac':
      return download.arch === 'x64' ? 'macX64' : 'macArm64';
    case 'linux':
      return download.arch === 'arm64' ? 'linuxArm64' : 'linuxX64';
  }
}

function buildVariant(download: DesktopDownload): BuildVariant {
  switch (download.kind) {
    case 'exe':
      return 'windows';
    case 'dmg':
      return download.arch === 'x64' ? 'macX64' : 'macArm64';
    case 'appimage':
      return download.arch === 'arm64' ? 'linuxAppImageArm64' : 'linuxAppImageX64';
    case 'deb':
      return download.arch === 'arm64' ? 'linuxDebArm64' : 'linuxDebX64';
  }
}

/**
 * The same build for the other architecture. Named in the note that admits the
 * architecture was a guess, so the visitor knows which entry of the list below
 * to take when the offered build does not run.
 */
function otherArchBuild(primary: DesktopDownload, others: DesktopDownload[]): DesktopDownload | null {
  if (!primary.arch) return null;
  return others.find(
    (build) => build.os === primary.os && build.kind === primary.kind && build.arch !== primary.arch,
  ) ?? null;
}

const LINK_CLASS = 'text-sm text-txt-secondary hover:text-txt-primary transition-colors';

/**
 * The desktop app download, offered in the browser. It detects the visitor's
 * platform to put one build in front and keeps every other build one click
 * away, because detection can be wrong and a visitor may be downloading for
 * another machine.
 *
 * `version` is the instance version, or null while the instance info request is
 * in flight or after it failed. Any version that is not a plain
 * `major.minor.patch`, including the empty string this panel passes for null,
 * makes every link point at the releases listing, which is the honest answer
 * when there is no tag to download from. The server reports its version
 * verbatim from `packages/server/package.json`, so a development checkout
 * reports a plain triple like any other instance; the unloaded version is the
 * case that actually reaches that fallback.
 *
 * The hazard the fallback does not cover is a plain version whose tag is not
 * published yet, the window between a version bump landing and the release
 * going out. Those links name assets GitHub answers 404 for, and the "All
 * releases" link at the bottom is the recovery.
 */
export function DesktopDownloadPanel({ version }: { version: string | null }) {
  const { t } = useTranslation('settings');
  const [detected, setDetected] = useState<DetectedPlatform | null>(null);

  useEffect(() => {
    let active = true;
    detectDesktopPlatform(window.navigator)
      .then((platform) => {
        if (active) setDetected(platform);
      })
      .catch(() => {
        // Detection is documented never to reject; if it ever does, the full
        // list without a primary offer is still a usable page.
        if (active) setDetected({ os: 'other', arch: null, archGuessed: false });
      });
    return () => {
      active = false;
    };
  }, []);

  const links = detected ? buildDesktopDownloads(version ?? '', detected) : null;
  const alternate = links?.primary ? otherArchBuild(links.primary, links.others) : null;

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">{t('desktopDownload.title')}</h2>

      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-3">
        <p className="text-sm text-txt-secondary leading-relaxed">{t('desktopDownload.intro')}</p>

        {detected && links && (
          <>
            {links.primary ? (
              <div className="space-y-1.5">
                <a
                  href={links.primary.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-3 py-1.5 text-sm font-medium text-white bg-accent-primary hover:bg-accent-primary/80 rounded-lg transition-colors"
                >
                  {t(PRIMARY_LABEL_KEYS[primaryVariant(links.primary)])}
                </a>
                {detected.archGuessed && alternate && (
                  <p className="text-xs text-txt-tertiary leading-relaxed">
                    {t('desktopDownload.archGuessed', {
                      build: t(BUILD_LABEL_KEYS[buildVariant(alternate)]),
                    })}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-txt-tertiary leading-relaxed">
                {t('desktopDownload.unsupported')}
              </p>
            )}

            <ul className="space-y-1.5">
              {links.others.map((download) => (
                <li key={download.filename}>
                  <a href={download.url} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
                    {t(BUILD_LABEL_KEYS[buildVariant(download)])}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}

        <a
          href={links?.allReleasesUrl ?? RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-block ${LINK_CLASS}`}
        >
          {t('desktopDownload.allReleases')}
        </a>
      </div>
    </div>
  );
}
