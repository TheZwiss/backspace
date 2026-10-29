import React from 'react';
import type { Activity } from '@backspace/shared';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { replaceEmojiShortcodes } from '../../utils/emojiShortcodes';
import { useFormatters } from '../../i18n/formatters';
import { AppIcon } from './AppIcon';
import {
  ActivityArtwork,
  PROFILE_ROW_ART,
  isRenderableActivityImage,
  useNowTick,
} from './ActivityCard';

interface ProfileActivitiesProps {
  activities: Activity[];
  skipCustom?: boolean;
}

function formatElapsed(startMs: number, t: TFunction<['social', 'common']>): string {
  const elapsed = Date.now() - startMs;
  const minutes = Math.floor(elapsed / 60000);
  const hours = Math.floor(minutes / 60);
  const duration = hours > 0
    ? t('common:time.hoursMinutesShort', { hours, minutes: minutes % 60 })
    : t('common:time.minutesShort', { minutes });
  return t('common:time.elapsed', { duration });
}

/** Minimal translate signature so callers holding any namespace set can pass `t`. */
type PlayerNameT = (key: string, options: { defaultValue: string }) => string;

export function formatPlayerName(player: string | undefined, t: PlayerNameT): string {
  if (!player) return '';
  const key = player.toLowerCase().replace(/[\s\-_.]+/g, '');
  if (key === 'cloudmusic' || key === '网易云音乐' || key === 'neteasecloudmusic') {
    return t('social:activity.players.cloudmusic', { defaultValue: 'NetEase Cloud Music' });
  }
  if (key === 'qqmusic' || key === 'qq音乐') {
    return t('social:activity.players.qqmusic', { defaultValue: 'QQ Music' });
  }
  if (key === 'kugou' || key === '酷狗音乐' || key === 'kugoumusic') {
    return t('social:activity.players.kugou', { defaultValue: 'KuGou' });
  }
  if (key === 'kuwo' || key === 'kwmusic' || key === '酷我音乐' || key === 'kuwomusic') {
    return t('social:activity.players.kuwo', { defaultValue: 'Kuwo' });
  }
  if (key === 'spotify') {
    return t('social:activity.players.spotify', { defaultValue: 'Spotify' });
  }
  if (key === 'applemusic' || key === 'apple') {
    return t('social:activity.players.applemusic', { defaultValue: 'Apple Music' });
  }
  if (key === 'yandexmusic' || key === 'яндексмузыка') {
    return t('social:activity.players.yandexmusic', { defaultValue: 'Yandex Music' });
  }
  return player;
}

function formatSeconds(totalSeconds: number): string {
  const m = Math.floor(Math.max(0, totalSeconds) / 60);
  const s = Math.floor(Math.max(0, totalSeconds) % 60);
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

function MediaProgress({
  start,
  end,
  now: propNow,
  barColorClass = 'bg-accent-sky',
}: {
  start: number;
  end: number;
  now?: number;
  barColorClass?: string;
}) {
  const localNow = useNowTick(propNow === undefined);
  const now = propNow ?? localNow;

  const total = Math.max(1, end - start);
  const elapsed = Math.min(total, Math.max(0, now - start));
  const percent = Math.min(100, Math.max(0, (elapsed / total) * 100));

  return (
    <div className="mt-2.5">
      <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColorClass} rounded-full transition-all duration-300`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-txt-tertiary mt-1 font-mono">
        <span>{formatSeconds(elapsed / 1000)}</span>
        <span>{formatSeconds(total / 1000)}</span>
      </div>
    </div>
  );
}

function MusicCard({ activity }: { activity: Activity }) {
  const { t } = useTranslation(['social', 'common']);
  const { formatDuration } = useFormatters();
  const player = formatPlayerName(activity.assets?.smallText, t);
  const hasCover = isRenderableActivityImage(activity.assets?.largeImage);

  const effectiveStart = typeof activity.timestamps?.start === 'number'
    ? activity.timestamps.start
    : (typeof activity.playback?.positionMs === 'number'
      ? Date.now() - activity.playback.positionMs
      : undefined);

  const hasTimer = typeof effectiveStart === 'number' || typeof activity.timestamps?.end === 'number';
  const now = useNowTick(hasTimer);
  const hasEndCountdown =
    typeof activity.timestamps?.end === 'number' && activity.timestamps.end > now;
  const timeText = hasEndCountdown
    ? t('common:time.left', { duration: formatDuration((activity.timestamps!.end! - now) / 1000) })
    : typeof effectiveStart === 'number'
      ? t('common:time.elapsed', { duration: formatDuration(Math.max(0, now - effectiveStart) / 1000) })
      : null;

  return (
    <div className="rounded-lg p-3 bg-accent-sky/[0.08] border border-accent-sky/20 mb-2.5 transition-all duration-200 hover:border-accent-sky/35">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-accent-sky">
          <span>🎵</span>
          <span>{t('social:activity.types.listening', { defaultValue: 'Listening to Music' })}</span>
        </div>
        {player && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-sky/20 text-accent-sky font-medium">
            {player}
          </span>
        )}
      </div>

      <div className="flex gap-3 items-center">
        {hasCover ? (
          <img
            key={activity.assets!.largeImage}
            src={activity.assets!.largeImage}
            alt=""
            className="w-12 h-12 rounded object-cover flex-shrink-0 shadow-sm transition-opacity duration-300 animate-fade-in"
          />
        ) : (
          <div className="w-12 h-12 rounded bg-accent-sky/20 flex items-center justify-center text-accent-sky flex-shrink-0 shadow-sm transition-colors duration-300">
            <AppIcon name={activity.assets?.smallText || activity.name} type="listening" size={24} fallbackEmoji="🎵" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-txt-primary truncate" title={activity.name}>
            {activity.name}
          </div>
          {activity.details && (
            <div className="text-[12px] text-txt-secondary truncate" title={activity.details}>
              {activity.details}
            </div>
          )}
          {activity.state && (
            <div className="text-[11px] text-txt-tertiary truncate" title={activity.state}>
              {activity.state}
            </div>
          )}
        </div>
      </div>

      {effectiveStart !== undefined && activity.timestamps?.end && (
        <MediaProgress
          start={effectiveStart}
          end={activity.timestamps.end}
          now={now}
          barColorClass="bg-accent-sky"
        />
      )}

      {effectiveStart !== undefined && !activity.timestamps?.end && timeText && (
        <div className="text-[10px] text-txt-tertiary mt-2 tabular-nums">
          {timeText}
        </div>
      )}

      {activity.url && (
        <a
          href={activity.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-accent-sky hover:underline mt-2 font-medium"
        >
          <span>{t('social:activity.openTrack', { defaultValue: 'Open Track' })}</span>
          <span>↗</span>
        </a>
      )}
    </div>
  );
}

function ProcessCard({
  activity,
  accentClass,
  headerText,
  icon,
}: {
  activity: Activity;
  accentClass: string;
  headerText: string;
  icon: string;
}) {
  const { t } = useTranslation(['social', 'common']);
  const { formatDuration } = useFormatters();

  const hasRemoteArt =
    isRenderableActivityImage(activity.assets?.largeImage) ||
    isRenderableActivityImage(activity.assets?.smallImage);

  const hasTimer =
    typeof activity.timestamps?.start === 'number' || typeof activity.timestamps?.end === 'number';
  const now = useNowTick(hasTimer);
  const hasEndCountdown =
    typeof activity.timestamps?.end === 'number' && activity.timestamps.end > now;
  const timeText = hasEndCountdown
    ? t('common:time.left', { duration: formatDuration((activity.timestamps!.end! - now) / 1000) })
    : typeof activity.timestamps?.start === 'number' && activity.timestamps.start <= now
      ? formatElapsed(activity.timestamps.start, t)
      : null;

  const barColorClass =
    activity.type === 'watching'
      ? 'bg-accent-lavender'
      : activity.type === 'streaming'
        ? 'bg-accent-rose'
        : 'bg-accent-mint';

  return (
    <div className={`rounded-lg p-3 ${accentClass} mb-2.5 transition-all duration-200 hover:brightness-105`}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider mb-2">
        <span>{icon}</span>
        <span>{headerText}</span>
      </div>
      <div className="flex gap-2.5 items-center">
        {hasRemoteArt ? (
          <ActivityArtwork
            largeImage={
              isRenderableActivityImage(activity.assets?.largeImage)
                ? activity.assets.largeImage
                : null
            }
            smallImage={
              isRenderableActivityImage(activity.assets?.smallImage)
                ? activity.assets.smallImage
                : null
            }
            largeAlt={activity.assets?.largeText || activity.name}
            smallAlt={activity.assets?.smallText}
            size={PROFILE_ROW_ART}
            placeholder={
              <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0 shadow-sm">
                <AppIcon name={activity.name} type={activity.type} size={20} fallbackEmoji={icon} />
              </div>
            }
          />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0 shadow-sm">
            <AppIcon name={activity.name} type={activity.type} size={20} fallbackEmoji={icon} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-txt-primary truncate" title={activity.name}>
            {activity.name}
          </div>
          {activity.details && (
            <div className="text-[12px] opacity-90 truncate mt-0.5" title={activity.details}>
              {replaceEmojiShortcodes(activity.details)}
            </div>
          )}
          {activity.state && (
            <div className="text-[11px] opacity-75 truncate mt-0.5" title={activity.state}>
              {replaceEmojiShortcodes(activity.state)}
            </div>
          )}
          {timeText && !activity.timestamps?.end && (
            <div className="text-[10px] opacity-75 mt-1 tabular-nums">
              {timeText}
            </div>
          )}
        </div>
      </div>

      {activity.timestamps?.start && activity.timestamps?.end && (
        <MediaProgress start={activity.timestamps.start} end={activity.timestamps.end} now={now} barColorClass={barColorClass} />
      )}

      {activity.url && (
        <a
          href={activity.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] opacity-90 hover:underline mt-2 font-medium"
        >
          <span>{t('social:activity.openTrack', { defaultValue: 'Open' })}</span>
          <span>↗</span>
        </a>
      )}
    </div>
  );
}

const ACTIVITY_PRIORITY: Record<string, number> = {
  streaming: 5,
  playing: 4,
  watching: 3,
  listening: 2,
  custom: 1,
};

export function ProfileActivities({ activities, skipCustom }: ProfileActivitiesProps) {
  const { t } = useTranslation(['social', 'common']);
  if (!activities || activities.length === 0) return null;

  const custom = !skipCustom ? activities.find((a) => a.type === 'custom') : null;
  const nonCustom = activities
    .filter((a) => a.type !== 'custom')
    .sort((a, b) => (ACTIVITY_PRIORITY[b.type] ?? 0) - (ACTIVITY_PRIORITY[a.type] ?? 0));

  return (
    <div className="mt-3 transition-opacity duration-200">
      {custom && (
        <div className="text-[13px] text-txt-secondary italic mb-2">
          {replaceEmojiShortcodes(custom.name)}
        </div>
      )}

      {nonCustom.map((activity, index) => {
        const key = `${activity.type}-${activity.name}-${index}`;
        if (activity.type === 'listening') {
          return <MusicCard key={key} activity={activity} />;
        }
        if (activity.type === 'streaming') {
          return (
            <ProcessCard
              key={key}
              activity={activity}
              accentClass="bg-accent-rose/[0.08] border border-accent-rose/20 text-accent-rose"
              headerText={t('social:activity.types.streaming', { defaultValue: 'Streaming' })}
              icon="🔴"
            />
          );
        }
        if (activity.type === 'playing') {
          return (
            <ProcessCard
              key={key}
              activity={activity}
              accentClass="bg-accent-mint/[0.08] border border-accent-mint/20 text-accent-mint"
              headerText={t('social:activity.types.playing', { defaultValue: 'Playing a Game' })}
              icon="🎮"
            />
          );
        }
        if (activity.type === 'watching') {
          return (
            <ProcessCard
              key={key}
              activity={activity}
              accentClass="bg-accent-lavender/[0.08] border border-accent-lavender/20 text-accent-lavender"
              headerText={t('social:activity.types.watching', { defaultValue: 'Watching' })}
              icon="📺"
            />
          );
        }
        return null;
      })}
    </div>
  );
}
