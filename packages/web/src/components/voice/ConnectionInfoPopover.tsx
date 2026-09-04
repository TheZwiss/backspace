import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useTrackStats, AudioTrackStat, VideoTrackStat } from '../../hooks/useTrackStats';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import i18n from '../../i18n';
import { formatters } from '../../i18n/formatters';

interface ConnectionInfoPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

/** Whole kbps below 1 Mbps, one decimal up to 10 Mbps, whole Mbps above; the number itself goes through the locale. */
function formatBitrate(kbps: number): string {
  if (kbps < 1000) {
    return i18n.t('common:units.kbps', { value: formatters.formatNumber(Math.round(kbps)) });
  }
  const mbps = kbps >= 10000 ? Math.round(kbps / 1000) : Math.round(kbps / 100) / 10;
  return i18n.t('common:units.mbps', { value: formatters.formatNumber(mbps) });
}

function formatMilliseconds(ms: number): string {
  return i18n.t('common:units.ms', { value: formatters.formatNumber(ms) });
}

/** Packet loss keeps one decimal so a 0.3% loss does not read as 0%. */
function formatLossPercent(pct: number): string {
  return i18n.t('common:units.percent', { value: formatters.formatNumber(Math.round(pct * 10) / 10) });
}

function pingColor(ms: number): string {
  if (ms <= 80) return 'text-status-online';
  if (ms <= 200) return 'text-status-idle';
  return 'text-txt-danger';
}

function lossColor(pct: number): string {
  if (pct <= 1) return 'text-status-online';
  if (pct <= 5) return 'text-status-idle';
  return 'text-txt-danger';
}

function jitterColor(ms: number): string {
  if (ms <= 30) return 'text-status-online';
  if (ms <= 80) return 'text-status-idle';
  return 'text-txt-danger';
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'microphone': return i18n.t('voice:connectionInfo.source.microphone');
    case 'camera': return i18n.t('voice:connectionInfo.source.camera');
    case 'screen_share': return i18n.t('voice:connectionInfo.source.screen');
    case 'screen_share_audio': return i18n.t('voice:connectionInfo.source.screenAudio');
    default: return i18n.t('voice:connectionInfo.source.unknown');
  }
}

function trackLabel(direction: 'send' | 'recv', source: string, participantName: string | null): string {
  const arrow = direction === 'send' ? '\u2191' : '\u2193';
  if (direction === 'send') {
    return `${sourceLabel(source)} ${arrow}`;
  }
  const name = participantName ?? i18n.t('voice:connectionInfo.remoteParticipant');
  return `${name} ${sourceLabel(source)} ${arrow}`;
}

const Row = ({ label, value, colorClass }: { label: string; value: string; colorClass?: string }) => (
  <div className="flex items-center justify-between py-[3px]">
    <span className="text-[12px] text-txt-tertiary">{label}</span>
    <span className={`text-[12px] font-medium ${colorClass ?? 'text-txt-secondary'}`}>{value}</span>
  </div>
);

const Divider = () => <div className="border-t border-border-soft my-1" />;

const SectionHeader = ({ title }: { title: string }) => (
  <div className="text-[10px] font-bold text-txt-tertiary uppercase tracking-wider pt-1 pb-[2px]">
    {title}
  </div>
);

function AudioTrackRow({ track }: { track: AudioTrackStat }) {
  const label = trackLabel(track.direction, track.source, track.participantName);
  return (
    <div className="flex items-center justify-between py-[3px]">
      <span className="text-[12px] text-txt-tertiary truncate mr-2">{label}</span>
      <span className="text-[12px] font-medium text-txt-secondary whitespace-nowrap">
        {formatBitrate(track.bitrate)}
        {track.codec && <span className="text-txt-tertiary ml-2">{track.codec}</span>}
      </span>
    </div>
  );
}

function VideoTrackRow({ track }: { track: VideoTrackStat }) {
  const label = trackLabel(track.direction, track.source, track.participantName);
  const resolution = (track.width && track.height) ? `${track.width}\u00d7${track.height}` : null;

  return (
    <div className="py-[3px]">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-txt-tertiary truncate mr-2">{label}</span>
        <span className="text-[12px] font-medium text-txt-secondary whitespace-nowrap">
          {formatBitrate(track.bitrate)}
          {track.codec && <span className="text-txt-tertiary ml-2">{track.codec}</span>}
        </span>
      </div>
      {(resolution || track.fps !== null || track.qualityLimitation || track.simulcastLayer || track.encoderImpl) && (
        <div className="flex items-center justify-between pl-3">
          <span className="text-[11px] text-txt-tertiary">
            {resolution && `${resolution}`}
            {track.fps !== null && ` @${track.fps}`}
          </span>
          <span className="text-[11px] text-txt-tertiary">
            {track.direction === 'send' && (() => {
              const parts: string[] = [];
              if (track.encoderImpl) parts.push(track.encoderImpl);
              if (track.qualityLimitation && track.qualityLimitation !== 'none') parts.push(track.qualityLimitation);
              return parts.join(' · ') || null;
            })()}
            {track.direction === 'recv' && track.simulcastLayer
              ? track.simulcastLayer
              : ''}
          </span>
        </div>
      )}
    </div>
  );
}

export function ConnectionInfoPopover({ open, onClose, anchorRef }: ConnectionInfoPopoverProps) {
  const { t } = useTranslation(['voice', 'common']);
  const popoverRef = useRef<HTMLDivElement>(null);
  const portalContainer = usePortalContainer();
  const stats = useTrackStats(open);

  const { style } = useFloatingPosition(anchorRef, popoverRef, {
    placement: 'top',
    offset: 12,
    enabled: open,
  });

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);

  if (!open) return null;

  const room = getActiveRoom();

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className="w-[300px] glass rounded-lg overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-border-hard">
        <span className="text-[14px] font-bold text-txt-primary">{t('voice:connectionInfo.title')}</span>
      </div>

      <div className="px-3 py-2 max-h-[calc(100vh-32px)] overflow-y-auto scrollbar-thin">
        {!room ? (
          <div className="text-[12px] text-txt-tertiary py-2 text-center">{t('voice:connectionInfo.notConnected')}</div>
        ) : !stats ? (
          <div className="text-[12px] text-txt-tertiary py-2 text-center">{t('voice:connectionInfo.gathering')}</div>
        ) : (
          <>
            {/* Network */}
            <SectionHeader title={t('voice:connectionInfo.section.network')} />
            <Row
              label={t('voice:connectionInfo.network.ping')}
              value={stats.network.ping !== null ? formatMilliseconds(stats.network.ping) : '\u2014'}
              colorClass={stats.network.ping !== null ? pingColor(stats.network.ping) : undefined}
            />
            <Row
              label={t('voice:connectionInfo.network.packetLoss')}
              value={stats.network.packetLoss !== null ? formatLossPercent(stats.network.packetLoss) : '\u2014'}
              colorClass={stats.network.packetLoss !== null ? lossColor(stats.network.packetLoss) : undefined}
            />
            <Row
              label={t('voice:connectionInfo.network.jitter')}
              value={stats.network.jitter !== null ? formatMilliseconds(stats.network.jitter) : '\u2014'}
              colorClass={stats.network.jitter !== null ? jitterColor(stats.network.jitter) : undefined}
            />
            <Row label={t('voice:connectionInfo.network.server')} value={stats.network.serverAddress ?? '\u2014'} />
            <Row
              label={t('voice:connectionInfo.network.protocol')}
              value={
                stats.network.protocol
                  ? `${stats.network.protocol}${stats.network.candidateType ? ` (${stats.network.candidateType})` : ''}`
                  : '\u2014'
              }
            />

            {/* Audio Tracks */}
            {stats.audioTracks.length > 0 && (
              <>
                <Divider />
                <SectionHeader title={t('voice:connectionInfo.section.audio')} />
                {stats.audioTracks.map((t) => (
                  <AudioTrackRow key={t.key} track={t} />
                ))}
              </>
            )}

            {/* Video Tracks */}
            {stats.videoTracks.length > 0 && (
              <>
                <Divider />
                <SectionHeader title={t('voice:connectionInfo.section.video')} />
                {stats.videoTracks.map((t) => (
                  <VideoTrackRow key={t.key} track={t} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>,
    portalContainer,
  );
}
