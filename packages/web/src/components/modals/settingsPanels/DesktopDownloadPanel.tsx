import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildDesktopDownloads,
  detectDesktopPlatform,
  RELEASES_URL,
  type DesktopArch,
  type DesktopDownload,
  type DetectedPlatform,
} from '../../../platform/desktopDownload';
import './DesktopDownloadPanel.css';

/** The three platforms a release carries a build for. */
type Platform = 'windows' | 'mac' | 'linux';

/** The two Linux package formats electron-builder emits. */
type LinuxKind = 'appimage' | 'deb';

/**
 * The order the quiet tiles are offered in, and the order of the stacked three.
 * Windows, Linux, macOS is the platform order everywhere a visitor sees a
 * download list: here, the README table and the Downloads table in the notes
 * of every release.
 */
const PLATFORMS: readonly Platform[] = ['windows', 'linux', 'mac'];

// The keys are spelled out rather than built from the platform, so the typed
// `t` checks every one of them and a renamed key fails the build.
const NAME_KEYS = {
  windows: 'desktopDownload.name.windows',
  mac: 'desktopDownload.name.mac',
  linux: 'desktopDownload.name.linux',
} as const satisfies Record<Platform, string>;

const TAG_KEYS = {
  windows: 'desktopDownload.tag.windows',
  mac: 'desktopDownload.tag.mac',
  linux: 'desktopDownload.tag.linux',
} as const satisfies Record<Platform, string>;

const COVERS_KEYS = {
  windows: 'desktopDownload.covers.windows',
  mac: 'desktopDownload.covers.mac',
  linux: 'desktopDownload.covers.linux',
} as const satisfies Record<Platform, string>;

const DOWNLOAD_KEYS = {
  windows: 'desktopDownload.download.windows',
  mac: 'desktopDownload.download.mac',
  linux: 'desktopDownload.download.linux',
} as const satisfies Record<Platform, string>;

/**
 * The note shown when the browser would not name the architecture and the
 * picker starts on the platform default. Each names the chip the way that
 * platform's owners do.
 */
const ARCH_GUESSED_KEYS = {
  windows: 'desktopDownload.archGuessed.windows',
  mac: 'desktopDownload.archGuessed.mac',
  linux: 'desktopDownload.archGuessed.linux',
} as const satisfies Record<Platform, string>;

/**
 * The identity mark, and the whole of it. A 3px bar in one pastel token per
 * platform, because the vendors' logos are trademarks this project has no
 * licence to put on a page.
 */
const ACCENT_BARS = {
  windows: 'bg-accent-sky',
  mac: 'bg-accent-lavender',
  linux: 'bg-accent-mint',
} as const satisfies Record<Platform, string>;

/** What each tile's picker currently points at. Local to the panel, never persisted. */
interface Selection {
  windowsArch: DesktopArch;
  macArch: DesktopArch;
  linuxKind: LinuxKind;
  linuxArch: DesktopArch;
}

/** The same defaults the link builder falls back to when the browser says nothing. */
const DEFAULT_SELECTION: Selection = {
  windowsArch: 'x64',
  macArch: 'arm64',
  linuxKind: 'appimage',
  linuxArch: 'x64',
};

/** Detection only ever informs the detected platform's own picker; the rest keep their defaults. */
function selectionFor(detected: DetectedPlatform): Selection {
  if (detected.arch === null) return DEFAULT_SELECTION;
  if (detected.os === 'windows') return { ...DEFAULT_SELECTION, windowsArch: detected.arch };
  if (detected.os === 'mac') return { ...DEFAULT_SELECTION, macArch: detected.arch };
  if (detected.os === 'linux') return { ...DEFAULT_SELECTION, linuxArch: detected.arch };
  return DEFAULT_SELECTION;
}

/** The build a tile's picker currently names, out of the eight the release carries. */
function downloadFor(
  builds: readonly DesktopDownload[],
  platform: Platform,
  selection: Selection,
): DesktopDownload | null {
  const matches = (kind: DesktopDownload['kind'], arch: DesktopArch) =>
    builds.find((build) => build.os === platform && build.kind === kind && build.arch === arch) ?? null;
  switch (platform) {
    case 'windows':
      return matches('exe', selection.windowsArch);
    case 'mac':
      return matches('dmg', selection.macArch);
    case 'linux':
      return matches(selection.linuxKind, selection.linuxArch);
  }
}

interface Segment<T extends string> {
  value: T;
  label: string;
}

/**
 * One choice on a sunken track. A radio group rather than a select because
 * every option is worth showing: the visitor is picking between two builds of
 * the same app, not filling in a form field.
 */
function SegmentedPicker<T extends string>({
  label,
  value,
  segments,
  onChange,
}: {
  label: string;
  value: T;
  segments: readonly Segment<T>[];
  onChange: (next: T) => void;
}) {
  // A radio group is one tab stop: the arrow keys move within it, and the
  // element they move to has to take the focus with it.
  const nodes = useRef(new Map<T, HTMLButtonElement>());

  const move = (delta: number) => {
    const index = segments.findIndex((segment) => segment.value === value);
    if (index < 0) return;
    const next = segments[(index + delta + segments.length) % segments.length];
    if (!next) return;
    onChange(next.value);
    nodes.current.get(next.value)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className="inline-flex gap-0.5 rounded-lg bg-surface-input p-0.5"
    >
      {segments.map((segment) => {
        const checked = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            ref={(node) => {
              if (node) nodes.current.set(segment.value, node);
              else nodes.current.delete(segment.value);
            }}
            onClick={() => onChange(segment.value)}
            // The selected segment has to read as raised off the sunken track
            // against the hero's own surface, which is already lighter than the
            // track: at the 8% the design called for it measured within three
            // levels of the hero background and the selection showed only in
            // the text colour.
            className={`px-3 py-1 text-xs rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 ${
              checked ? 'bg-white/[0.12] text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary'
            }`}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The platform's name with its accent bar, at the size its tier calls for.
 *
 * The bar hangs in the tile's padding, outside the text column: kept in flow it
 * pushed the name 13px right of the coverage line, the picker and the button,
 * and a heading that does not share the block's left edge reads as a mistake
 * rather than as a marked one.
 */
function PlatformName({ platform, id, hero }: { platform: Platform; id: string; hero: boolean }) {
  const { t } = useTranslation('settings');
  return (
    <div className="relative flex items-center min-w-0">
      <span
        aria-hidden="true"
        className={`absolute right-full mr-2 top-1/2 -translate-y-1/2 w-[3px] rounded-full ${
          hero ? 'h-[22px]' : 'h-[18px]'
        } ${ACCENT_BARS[platform]}`}
      />
      <h3
        id={id}
        className={`truncate text-txt-primary font-semibold ${hero ? 'text-2xl leading-tight' : 'text-base leading-snug'}`}
      >
        {t(NAME_KEYS[platform])}
      </h3>
    </div>
  );
}

/**
 * The detected platform, full width and one material step above the rest. It
 * is the only tile that names the machine the visitor is on, and the only one
 * with a filled button.
 */
function HeroTile({
  platform,
  nameId,
  href,
  pickers,
  versionLabel,
  guessedNote,
}: {
  platform: Platform;
  nameId: string;
  href: string;
  pickers: ReactNode;
  versionLabel: string | null;
  guessedNote: string | null;
}) {
  const { t } = useTranslation('settings');
  return (
    <section
      aria-labelledby={nameId}
      data-tile="hero"
      className="rounded-2xl border border-accent-primary/30 bg-white/[0.05] p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <PlatformName platform={platform} id={nameId} hero />
        <span className="glass-pill shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-txt-secondary">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-accent-mint" />
          {t(TAG_KEYS[platform])}
        </span>
      </div>

      <p className="mt-2 text-sm text-txt-secondary">{t(COVERS_KEYS[platform])}</p>

      {pickers && <div className="mt-4 flex flex-wrap gap-2">{pickers}</div>}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="px-4 py-2 text-sm font-medium text-white bg-accent-primary hover:bg-accent-primary-hover rounded-lg transition-colors"
        >
          {t(DOWNLOAD_KEYS[platform])}
        </a>
        {versionLabel && <span className="text-xs text-txt-tertiary">{versionLabel}</span>}
      </div>

      {guessedNote && <p className="mt-2 text-xs text-txt-tertiary">{guessedNote}</p>}
    </section>
  );
}

/** A platform the visitor is not on. Same information, a quieter material and a text link. */
function QuietTile({
  platform,
  nameId,
  href,
  pickers,
}: {
  platform: Platform;
  nameId: string;
  href: string;
  pickers: ReactNode;
}) {
  const { t } = useTranslation('settings');
  return (
    // The content flows from the top and any spare height falls to the bottom
    // of the tile. Pinning the link to the bottom edge lined the pair's links
    // up, at the cost of a hollow band inside whichever tile has no picker.
    <section
      aria-labelledby={nameId}
      data-tile="quiet"
      className="min-w-0 rounded-2xl border border-white/[0.04] bg-white/[0.03] p-4"
    >
      <PlatformName platform={platform} id={nameId} hero={false} />
      <p className="mt-2 text-xs text-txt-tertiary">{t(COVERS_KEYS[platform])}</p>
      {pickers && <div className="mt-3 flex flex-wrap gap-2">{pickers}</div>}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-block text-sm font-medium text-accent-primary hover:text-accent-primary-hover transition-colors"
      >
        {t(DOWNLOAD_KEYS[platform])}
      </a>
    </section>
  );
}

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
 * releases on GitHub" link at the bottom is the recovery.
 */
export function DesktopDownloadPanel({ version }: { version: string | null }) {
  const { t } = useTranslation('settings');
  // Two panels can share a document (the design workbench mounts it twice), so
  // the heading ids the tiles point at have to be unique per mount.
  const idPrefix = useId();
  const [detected, setDetected] = useState<DetectedPlatform | null>(null);
  const [selection, setSelection] = useState<Selection>(DEFAULT_SELECTION);

  useEffect(() => {
    let active = true;
    const resolve = (platform: DetectedPlatform) => {
      if (!active) return;
      setDetected(platform);
      setSelection(selectionFor(platform));
    };
    detectDesktopPlatform(window.navigator)
      .then(resolve)
      // Detection is documented never to reject; if it ever does, the three
      // tiles without a hero are still a usable page.
      .catch(() => resolve({ os: 'other', arch: null, archGuessed: false }));
    return () => {
      active = false;
    };
  }, []);

  const links = detected ? buildDesktopDownloads(version ?? '', detected) : null;
  const builds = links ? [...(links.primary ? [links.primary] : []), ...links.others] : [];
  // A build the release does not carry falls back to the listing, which is the
  // honest answer rather than a link to a file that is not there.
  const hrefFor = (platform: Platform): string =>
    downloadFor(builds, platform, selection)?.url ?? links?.allReleasesUrl ?? RELEASES_URL;

  const heroPlatform: Platform | null = detected && detected.os !== 'other' ? detected.os : null;
  const quietPlatforms = PLATFORMS.filter((platform) => platform !== heroPlatform);

  const macSegments: readonly Segment<DesktopArch>[] = [
    { value: 'arm64', label: t('desktopDownload.arch.appleSilicon') },
    { value: 'x64', label: t('desktopDownload.arch.intel') },
  ];
  const linuxKindSegments: readonly Segment<LinuxKind>[] = [
    { value: 'appimage', label: t('desktopDownload.kind.appimage') },
    { value: 'deb', label: t('desktopDownload.kind.deb') },
  ];
  // Windows and Linux name their chips the same way; macOS has its own names.
  const plainArchSegments: readonly Segment<DesktopArch>[] = [
    { value: 'x64', label: t('desktopDownload.arch.x64') },
    { value: 'arm64', label: t('desktopDownload.arch.arm64') },
  ];

  /** Windows and mac choose a chip; Linux a format and a chip. */
  const pickersFor = (platform: Platform): ReactNode => {
    if (platform === 'windows') {
      return (
        <SegmentedPicker
          label={t('desktopDownload.picker.architecture')}
          value={selection.windowsArch}
          segments={plainArchSegments}
          onChange={(windowsArch) => setSelection((current) => ({ ...current, windowsArch }))}
        />
      );
    }
    if (platform === 'mac') {
      return (
        <SegmentedPicker
          label={t('desktopDownload.picker.architecture')}
          value={selection.macArch}
          segments={macSegments}
          onChange={(macArch) => setSelection((current) => ({ ...current, macArch }))}
        />
      );
    }
    return (
      <>
        <SegmentedPicker
          label={t('desktopDownload.picker.format')}
          value={selection.linuxKind}
          segments={linuxKindSegments}
          onChange={(linuxKind) => setSelection((current) => ({ ...current, linuxKind }))}
        />
        <SegmentedPicker
          label={t('desktopDownload.picker.architecture')}
          value={selection.linuxArch}
          segments={plainArchSegments}
          onChange={(linuxArch) => setSelection((current) => ({ ...current, linuxArch }))}
        />
      </>
    );
  };

  const guessedNote = detected?.archGuessed && heroPlatform ? t(ARCH_GUESSED_KEYS[heroPlatform]) : null;

  return (
    <div className="ddl-panel">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">{t('desktopDownload.title')}</h2>

      {detected && (
        <div className="mb-5 space-y-3">
          {heroPlatform ? (
            <HeroTile
              platform={heroPlatform}
              nameId={`${idPrefix}-${heroPlatform}`}
              href={hrefFor(heroPlatform)}
              pickers={pickersFor(heroPlatform)}
              versionLabel={version ? t('desktopDownload.version', { version }) : null}
              guessedNote={guessedNote}
            />
          ) : (
            <p className="text-sm text-txt-secondary">{t('desktopDownload.unsupported')}</p>
          )}

          <div className={`ddl-tiles${heroPlatform ? '' : ' ddl-tiles--stack'}`}>
            {quietPlatforms.map((platform) => (
              <QuietTile
                key={platform}
                platform={platform}
                nameId={`${idPrefix}-${platform}`}
                href={hrefFor(platform)}
                pickers={pickersFor(platform)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="text-xs text-txt-tertiary">{t('desktopDownload.intro')}</p>
        <a
          href={links?.allReleasesUrl ?? RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-txt-secondary hover:text-txt-primary transition-colors"
        >
          {t('desktopDownload.allReleases')}
        </a>
      </div>
    </div>
  );
}
