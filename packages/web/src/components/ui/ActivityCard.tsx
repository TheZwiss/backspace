import type { Activity } from '@backspace/shared';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { replaceEmojiShortcodes, useEmojiShortcodeNames } from '../../utils/emojiShortcodes';
import { useFormatters } from '../../i18n/formatters';
import { AppIcon } from './AppIcon';
import { formatPlayerName } from './ProfileActivities';

interface ActivityCardProps {
  activities: Activity[];
  fallbackCustomStatus?: string | null;
}

/**
 * Legacy elapsed-time formatter for backwards compatibility with tests.
 */
export function formatElapsed(startMs: number, t: TFunction<'common'>): string {
  const elapsed = Date.now() - startMs;
  const minutes = Math.floor(elapsed / 60000);
  const hours = Math.floor(minutes / 60);
  const duration = hours > 0
    ? t('time.hoursMinutesShort', { hours, minutes: minutes % 60 })
    : t('time.minutesShort', { minutes });
  return t('time.elapsed', { duration });
}

/**
 * Returns true if activities contain a rich (non-custom) activity.
 */
export function hasRichActivity(activities: Activity[]): boolean {
  return activities.some((a) => a.type !== 'custom');
}

/** Returns the accent border color class for an activity type */
export function getActivityAccentClass(type: Activity['type']): string {
  switch (type) {
    case 'playing': return 'border-l-accent-mint';
    case 'listening': return 'border-l-accent-sky';
    case 'watching': return 'border-l-accent-lavender';
    case 'streaming': return 'border-l-accent-rose';
    default: return '';
  }
}

/**
 * Only remote http(s) art is ever rendered. Activity data comes from other
 * users (or the local IPC push), so anything that is not a plain web URL —
 * data:/javascript:/relative paths — is dropped rather than trusted.
 */
export function isRenderableActivityImage(url: string | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** A ticking "now", re-rendering every second while `active`. */
export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * The activity time line: a countdown while the activity has a future end
 * ("2:14 left"), otherwise the elapsed time since start. Durations go
 * through the i18n formatters so digits follow the selected locale.
 */
export function activityTimeText(
  timestamps: { start?: number; end?: number },
  now: number,
  t: TFunction<'common'>,
  formatDuration: (elapsedSeconds: number) => string,
): string | null {
  const { start, end } = timestamps;
  if (typeof end === 'number' && end > now) {
    return t('time.left', { duration: formatDuration((end - now) / 1000) });
  }
  if (typeof start === 'number') {
    return t('time.elapsed', { duration: formatDuration(Math.max(0, now - start) / 1000) });
  }
  return null;
}

/** The class sets of one artwork size: the wrapper, the large image, the badge and a lone image. */
export interface ArtworkSize {
  wrapper: string;
  large: string;
  badge: string;
  single: string;
}

export const PROFILE_ROW_ART: ArtworkSize = {
  wrapper: 'relative shrink-0 w-10 h-10',
  large: 'w-10 h-10 rounded-lg object-cover bg-white/[0.04]',
  badge: 'absolute -bottom-1 -right-1 w-4 h-4 rounded-full object-cover bg-[#13131a] ring-2 ring-[rgba(20,20,26,0.85)]',
  single: 'w-10 h-10 rounded-lg object-cover bg-white/[0.04]',
};

/** Stand-in for a game without an icon: keeps the rows' text aligned. It is only drawn, never cached or uploaded. */
export function GameIconPlaceholder() {
  return (
    <div
      data-testid="game-icon-placeholder"
      aria-hidden="true"
      className="shrink-0 w-10 h-10 rounded-lg bg-white/[0.06] flex items-center justify-center text-txt-tertiary"
    >
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" />
        <path d="M17.3 5H6.7a4 4 0 0 0-3.9 3.1l-1.2 5.6A3 3 0 0 0 4.5 17.2c.8 0 1.5-.4 2-1l1.5-2h8l1.5 2c.5.6 1.2 1 2 1a3 3 0 0 0 2.9-3.5l-1.2-5.6A4 4 0 0 0 17.3 5Z" />
      </svg>
    </div>
  );
}

export const POPOUT_ART: ArtworkSize = {
  wrapper: 'relative shrink-0 w-[60px] h-[60px]',
  large: 'w-[60px] h-[60px] rounded-[10px] object-cover bg-white/[0.04]',
  badge: 'absolute -bottom-1.5 -right-1.5 w-[22px] h-[22px] rounded-full object-cover bg-[#13131a] ring-2 ring-[rgba(20,20,26,0.85)]',
  single: 'w-[60px] h-[60px] rounded-[10px] object-cover bg-white/[0.04]',
};

export interface ActivityArtworkProps {
  largeImage: string | null;
  smallImage: string | null;
  largeAlt: string;
  smallAlt?: string;
  size: ArtworkSize;
  /** Shown in place of the art when there is none, or none could be loaded. Never stored anywhere. */
  placeholder?: ReactNode;
}

/**
 * The art of an activity: the large image with the small one as a corner badge.
 * It owns the load state of both images, so the frame never stays behind empty:
 * an image that fails to load is dropped, and a badge left without its large
 * image is promoted to the full-size image. With nothing left to show it
 * renders nothing at all.
 */
export function ActivityArtwork({ largeImage, smallImage, largeAlt, smallAlt, size, placeholder }: ActivityArtworkProps) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const markFailed = (src: string) => setFailed((prev) => new Set(prev).add(src));

  const large = largeImage && !failed.has(largeImage) ? largeImage : null;
  const small = smallImage && !failed.has(smallImage) ? smallImage : null;
  if (!large && !small) return placeholder ? <>{placeholder}</> : null;

  if (large && small) {
    return (
      <div className={size.wrapper} data-testid="activity-artwork">
        <img key={large} src={large} alt={largeAlt} className={`${size.large} transition-opacity duration-300 animate-fade-in`} onError={() => markFailed(large)} />
        <img key={small} src={small} alt={smallAlt ?? ''} className={`${size.badge} transition-opacity duration-300 animate-fade-in`} onError={() => markFailed(small)} />
      </div>
    );
  }

  const lone = (large ?? small)!;
  const alt = large ? largeAlt : (smallAlt ?? largeAlt);
  return (
    <div className={size.wrapper} data-testid="activity-artwork">
      <img key={lone} src={lone} alt={alt} className={`${size.single} transition-opacity duration-300 animate-fade-in`} onError={() => markFailed(lone)} />
    </div>
  );
}

function otherGamesCount(activities: Activity[], primary: Activity): number {
  return activities.filter((a) => a.type === 'playing' && a !== primary && a.name).length;
}

function otherGameNames(activities: Activity[], primary: Activity): string {
  return activities
    .filter((a) => a.type === 'playing' && a !== primary && a.name)
    .map((a) => a.name)
    .join(', ');
}

/**
 * Renders activity details (app name + elapsed time, or music info, or dual status).
 * The glass card wrapper is applied by the parent row container.
 */
export function ActivityCard({ activities, fallbackCustomStatus }: ActivityCardProps) {
  useEmojiShortcodeNames();
  const { t } = useTranslation('common');
  const { formatDuration } = useFormatters();

  const music = activities.find((a) => a.type === 'listening');
  const processActivity =
    activities.find((a) => a.type === 'streaming') ||
    activities.find((a) => a.type === 'playing') ||
    activities.find((a) => a.type === 'watching');
  const custom = activities.find((a) => a.type === 'custom');

  // Music players can provide a live position even when they expose no duration,
  // so either activity needs to keep the shared clock ticking.
  const activeStart = processActivity?.timestamps?.start ?? music?.timestamps?.start;
  const activeEnd = processActivity?.timestamps?.end ?? music?.timestamps?.end;
  const hasTimer = typeof activeStart === 'number' || typeof activeEnd === 'number';
  const now = useNowTick(hasTimer);

  let content: ReactNode = null;

  if (processActivity && music) {
    const musicLine = `${music.name}${music.details ? ` · ${music.details}` : ''}`;
    content = (
      <div className="flex flex-col min-w-0">
        <div className="text-[11px] leading-[1.3] text-txt-secondary truncate flex items-center gap-1.5" title={processActivity.name}>
          <AppIcon name={processActivity.name} type={processActivity.type} size={11} className="flex-shrink-0" />
          <span className="truncate">{processActivity.name}</span>
        </div>
        <div
          className="text-[10px] leading-[1.3] text-accent-sky truncate flex items-center gap-1"
          title={musicLine}
        >
          <AppIcon name={music.assets?.smallText || music.name} type="listening" size={10} fallbackEmoji="🎵" className="flex-shrink-0" />
          <span className="truncate">{musicLine}</span>
        </div>
      </div>
    );
  } else if (music) {
    const musicLine = `${music.name}${music.details ? ` · ${music.details}` : ''}`;
    const musicTime = activityTimeText(music.timestamps ?? {}, now, t, formatDuration)
      ?? (typeof music.playback?.positionMs === 'number'
        ? t('time.elapsed', { duration: formatDuration(Math.max(0, music.playback.positionMs) / 1000) })
        : null);
    content = (
      <div className="flex flex-col min-w-0">
        <div className="text-[11px] leading-[1.3] text-txt-secondary truncate flex items-center gap-1.5" title={musicLine}>
          <AppIcon name={music.assets?.smallText || music.name} type="listening" size={11} fallbackEmoji="🎵" className="flex-shrink-0" />
          <span className="truncate">{musicLine}</span>
        </div>
        {musicTime ? (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary tabular-nums">
            {musicTime}
          </div>
        ) : music.assets?.smallText ? (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate">
            {formatPlayerName(music.assets.smallText, t)}
          </div>
        ) : null}
      </div>
    );
  } else if (processActivity) {
    const timeText = processActivity.timestamps?.end && processActivity.timestamps.end > now
      ? t('time.left', { duration: formatDuration((processActivity.timestamps.end - now) / 1000) })
      : processActivity.timestamps?.start
        ? formatElapsed(processActivity.timestamps.start, t)
        : null;
    const moreGames = otherGamesCount(activities, processActivity);

    content = (
      <div className="flex flex-col min-w-0">
        <div className="text-[11px] leading-[1.3] text-txt-secondary truncate flex items-center gap-1.5" title={processActivity.name}>
          <AppIcon name={processActivity.name} type={processActivity.type} size={11} className="flex-shrink-0" />
          <span className="truncate" title={processActivity.name}>{processActivity.name}</span>
          {moreGames > 0 && (
            <span className="shrink-0 text-[10px] font-normal text-txt-tertiary tabular-nums" title={otherGameNames(activities, processActivity)}>
              +{moreGames}
            </span>
          )}
        </div>
        {timeText && (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary tabular-nums">
            {timeText}
          </div>
        )}
      </div>
    );
  } else {
    const rawStatus = custom?.name || fallbackCustomStatus;
    if (rawStatus) {
      const statusText = replaceEmojiShortcodes(rawStatus);
      content = (
        <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate" title={statusText}>
          {statusText}
        </div>
      );
    }
  }

  const lastContentRef = useRef<ReactNode>(null);
  if (content !== null) {
    lastContentRef.current = content;
  }

  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (content === null && lastContentRef.current !== null) {
      setIsExiting(true);
      const timer = setTimeout(() => {
        setIsExiting(false);
        lastContentRef.current = null;
      }, 220);
      return () => clearTimeout(timer);
    }
    if (content !== null) {
      setIsExiting(false);
    }
  }, [content]);

  const activeNode = content ?? (isExiting ? lastContentRef.current : null);
  const isOpen = content !== null;

  return (
    <div className="activity-card-expand" data-open={isOpen ? 'true' : 'false'}>
      <div className="activity-card-expand-inner">
        {activeNode}
      </div>
    </div>
  );
}

/**
 * The rich card showing activity details — headline, details, state,
 * running time, and the large image with the small badge overlay.
 */
export function ActivityDetailCard({ activities }: { activities: Activity[] }) {
  useEmojiShortcodeNames();
  const { t } = useTranslation('common');
  const { formatDuration } = useFormatters();
  const primary = getPrimaryActivity(activities);

  const hasTimer = !!primary && primary.type !== 'custom' &&
    (typeof primary.timestamps?.start === 'number' || typeof primary.timestamps?.end === 'number');
  const now = useNowTick(hasTimer);

  if (!primary || primary.type === 'custom') return null;

  const headline = primary.name || primary.details;
  if (!headline) return null;

  const assets = primary.assets;
  const largeImage = isRenderableActivityImage(assets?.largeImage) ? assets.largeImage : null;
  const smallImage = isRenderableActivityImage(assets?.smallImage) ? assets.smallImage : null;
  const timeText = activityTimeText(primary.timestamps ?? {}, now, t, formatDuration);
  const moreGames = otherGamesCount(activities, primary);

  return (
    <div className="flex gap-3 items-start transition-all duration-200">
      <ActivityArtwork
        largeImage={largeImage}
        smallImage={smallImage}
        largeAlt={assets?.largeText || headline}
        smallAlt={assets?.smallText}
        size={POPOUT_ART}
        placeholder={
          <div className="w-[60px] h-[60px] rounded-[10px] bg-white/[0.06] flex items-center justify-center text-txt-secondary">
            <AppIcon name={headline} type={primary.type} size={28} />
          </div>
        }
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 min-w-0 text-[13px] font-medium leading-[1.3] text-txt-primary">
          <span className="truncate">{replaceEmojiShortcodes(headline)}</span>
          {moreGames > 0 && (
            <span className="shrink-0 text-[12px] font-normal text-txt-tertiary tabular-nums" title={otherGameNames(activities, primary)}>+{moreGames}</span>
          )}
        </div>
        {primary.details && primary.name && (
          <div className="text-[12px] leading-[1.3] text-txt-secondary truncate">
            {replaceEmojiShortcodes(primary.details)}
          </div>
        )}
        {primary.state && (
          <div className="text-[12px] leading-[1.3] text-txt-secondary truncate">
            {replaceEmojiShortcodes(primary.state)}
          </div>
        )}
        {timeText && (
          <div className="text-[11px] leading-[1.3] text-txt-tertiary tabular-nums">
            {timeText}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The full profile's list of everything the person is playing: one row per
 * game with its icon and its own running time.
 */
export function ProfileGamesList({ activities }: { activities: Activity[] }) {
  useEmojiShortcodeNames();
  const { t } = useTranslation('common');
  const { formatDuration } = useFormatters();
  const games = activities.filter((activity) => activity.type === 'playing' && activity.name);
  const ticking = games.some((game) => typeof game.timestamps?.start === 'number' || typeof game.timestamps?.end === 'number');
  const now = useNowTick(ticking);
  if (games.length === 0) return null;

  return (
    <ul className="space-y-2">
      {games.map((game, index) => {
        const timeText = activityTimeText(game.timestamps ?? {}, now, t, formatDuration);
        return (
          <li key={`${game.name}:${index}`} className="flex gap-3 items-center min-w-0">
            <ActivityArtwork
              largeImage={isRenderableActivityImage(game.assets?.largeImage) ? game.assets.largeImage : null}
              smallImage={isRenderableActivityImage(game.assets?.smallImage) ? game.assets.smallImage : null}
              largeAlt={game.assets?.largeText || game.name}
              smallAlt={game.assets?.smallText}
              size={PROFILE_ROW_ART}
              placeholder={<GameIconPlaceholder />}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium leading-[1.3] text-txt-primary truncate">{game.name}</div>
              {game.details && (
                <div className="text-[12px] leading-[1.3] text-txt-secondary truncate">{replaceEmojiShortcodes(game.details)}</div>
              )}
              {game.state && (
                <div className="text-[12px] leading-[1.3] text-txt-secondary truncate">{replaceEmojiShortcodes(game.state)}</div>
              )}
              {timeText && (
                <div className="text-[11px] leading-[1.3] text-txt-tertiary tabular-nums">{timeText}</div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
