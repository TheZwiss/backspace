import React, { useState, useEffect, useRef } from 'react';
import { Track } from 'livekit-client';
import { getActiveRoom } from '../../hooks/useLiveKit';

interface ConnectionInfoPopoverProps {
  open: boolean;
  onClose: () => void;
}

interface ConnectionStats {
  ping: number | null;
  packetLoss: number | null;
  jitter: number | null;
  audioUp: number | null;
  audioDown: number | null;
  videoUp: number | null;
  videoDown: number | null;
  audioCodec: string | null;
  videoCodec: string | null;
  resolution: string | null;
  fps: number | null;
  qualityLimitation: string | null;
  serverAddress: string | null;
  protocol: string | null;
  candidateType: string | null;
}

interface PrevSample {
  bytes: number;
  timestamp: number;
}

/**
 * Discover all unique RTCPeerConnections from the LiveKit Room engine.
 * Different livekit-client versions expose the PC at different internal paths.
 * We collect all of them and deduplicate, so the stats loop can process
 * outbound-rtp and inbound-rtp reports regardless of transport architecture
 * (split publisher/subscriber vs unified-plan single PC).
 */
function discoverPeerConnections(room: any): RTCPeerConnection[] {
  const engine = room?.engine;
  if (!engine) return [];

  const pcs: RTCPeerConnection[] = [];
  const seen = new WeakSet<object>();

  const tryAdd = (val: any) => {
    if (val && typeof val.getStats === 'function' && !seen.has(val)) {
      seen.add(val);
      pcs.push(val);
    }
  };

  // Current livekit-client (1.x+): engine.pcManager.{publisher,subscriber}.pc
  tryAdd(engine.pcManager?.publisher?.pc);
  tryAdd(engine.pcManager?.subscriber?.pc);
  // Private backing field fallback
  tryAdd(engine.pcManager?.publisher?._pc);
  tryAdd(engine.pcManager?.subscriber?._pc);
  // Older livekit-client paths
  tryAdd(engine.publisher?.pc);
  tryAdd(engine.subscriber?.pc);
  // Unified-plan single PC
  tryAdd(engine.pc);
  tryAdd(room.pc);

  return pcs;
}

/** Determine media kind from a WebRTC stats report (handles both spec and legacy fields). */
function reportKind(report: any): 'audio' | 'video' | null {
  const k = report.kind ?? report.mediaType;
  if (k === 'audio' || k === 'video') return k;
  return null;
}

function formatBitrate(bps: number | null): string {
  if (bps === null) return '\u2014';
  if (bps < 1000) return `${Math.round(bps)} kbps`;
  return `${(bps / 1000).toFixed(bps >= 10000 ? 0 : 1)} Mbps`;
}

function pingColor(ms: number): string {
  if (ms <= 80) return 'text-discord-green';
  if (ms <= 200) return 'text-discord-yellow';
  return 'text-discord-red';
}

function lossColor(pct: number): string {
  if (pct <= 1) return 'text-discord-green';
  if (pct <= 5) return 'text-discord-yellow';
  return 'text-discord-red';
}

function jitterColor(ms: number): string {
  if (ms <= 30) return 'text-discord-green';
  if (ms <= 80) return 'text-discord-yellow';
  return 'text-discord-red';
}

export function ConnectionInfoPopover({ open, onClose }: ConnectionInfoPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const prevSampleRef = useRef<Map<string, PrevSample>>(new Map());
  const [stats, setStats] = useState<ConnectionStats | null>(null);

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

  // Stats polling — only while open
  useEffect(() => {
    if (!open) {
      prevSampleRef.current.clear();
      setStats(null);
      return;
    }

    const poll = async () => {
      const room = getActiveRoom();
      if (!room) {
        setStats(null);
        return;
      }

      const pcs = discoverPeerConnections(room as any);
      if (pcs.length === 0) {
        setStats(null);
        return;
      }

      const result: ConnectionStats = {
        ping: null,
        packetLoss: null,
        jitter: null,
        audioUp: null,
        audioDown: null,
        videoUp: null,
        videoDown: null,
        audioCodec: null,
        videoCodec: null,
        resolution: null,
        fps: null,
        qualityLimitation: null,
        serverAddress: null,
        protocol: null,
        candidateType: null,
      };

      const prev = prevSampleRef.current;
      const now = performance.now();

      // Accumulators for inbound aggregate metrics
      let totalPacketsReceived = 0;
      let totalPacketsLost = 0;
      let totalAudioDown = 0;
      let hasAudioDown = false;
      let totalVideoDown = 0;
      let hasVideoDown = false;

      // Track candidate-pair remote ID for Safari fallback (see after forEach)
      let selectedCandidatePairRemoteId: string | null = null;

      // Process stats from ALL discovered PeerConnections.
      // Report types (outbound-rtp, inbound-rtp, candidate-pair, etc.) are
      // self-describing, so we don't need to know which PC they came from.
      for (const pc of pcs) {
        let reports: RTCStatsReport;
        try {
          reports = await pc.getStats();
        } catch {
          continue;
        }

        // Build codec map for this PC's stats (codecId → short name)
        const codecMap = new Map<string, string>();
        reports.forEach((report: any) => {
          if (report.type === 'codec') {
            codecMap.set(report.id, report.mimeType?.split('/')[1] ?? report.mimeType ?? '');
          }
        });

        reports.forEach((report: any) => {
          const kind = reportKind(report);

          // ── RTT from candidate-pair ──
          if (
            report.type === 'candidate-pair' &&
            report.state === 'succeeded'
          ) {
            if (report.currentRoundTripTime != null) {
              result.ping = Math.round(report.currentRoundTripTime * 1000);
            }
            // Safari fallback: collect remote candidate ID for post-loop lookup
            if (!result.serverAddress && report.remoteCandidateId) {
              selectedCandidatePairRemoteId = report.remoteCandidateId;
            }
          }

          // ── Outbound (publisher) ──
          if (report.type === 'outbound-rtp') {
            const key = `out-${report.ssrc}`;
            const prevEntry = prev.get(key);

            if (kind === 'audio') {
              if (prevEntry) {
                const deltaBits = (report.bytesSent - prevEntry.bytes) * 8;
                const deltaMs = now - prevEntry.timestamp;
                if (deltaMs > 0) result.audioUp = deltaBits / deltaMs;
              }
              prev.set(key, { bytes: report.bytesSent, timestamp: now });

              if (report.codecId && codecMap.has(report.codecId)) {
                result.audioCodec = codecMap.get(report.codecId)!;
              }
            }

            if (kind === 'video') {
              if (prevEntry) {
                const deltaBits = (report.bytesSent - prevEntry.bytes) * 8;
                const deltaMs = now - prevEntry.timestamp;
                if (deltaMs > 0) {
                  const bitrate = deltaBits / deltaMs;
                  // Only accumulate when bitrate > 0 — filters stale outbound-rtp
                  // reports that Safari/Chrome retain after camera/screenshare stops
                  if (bitrate > 0) {
                    result.videoUp = (result.videoUp ?? 0) + bitrate;
                  }
                }
              }
              prev.set(key, { bytes: report.bytesSent, timestamp: now });

              if (report.codecId && codecMap.has(report.codecId)) {
                result.videoCodec = codecMap.get(report.codecId)!;
              }

              // Resolution + FPS — take the active track (non-zero dimensions)
              if (report.frameWidth > 0 && report.frameHeight > 0) {
                result.resolution = `${report.frameWidth}\u00d7${report.frameHeight}`;
                result.fps = Math.round(report.framesPerSecond || 0);
              }

              if (report.qualityLimitationReason) {
                result.qualityLimitation = report.qualityLimitationReason;
              }
            }
          }

          // ── Inbound (subscriber) ──
          if (report.type === 'inbound-rtp') {
            const key = `in-${report.ssrc}`;
            const prevEntry = prev.get(key);

            if (kind === 'audio') {
              if (result.jitter === null && report.jitter != null) {
                result.jitter = Math.round(report.jitter * 1000);
              }
              totalPacketsReceived += report.packetsReceived || 0;
              totalPacketsLost += report.packetsLost || 0;

              if (prevEntry) {
                const deltaBits = (report.bytesReceived - prevEntry.bytes) * 8;
                const deltaMs = now - prevEntry.timestamp;
                if (deltaMs > 0) {
                  totalAudioDown += deltaBits / deltaMs;
                  hasAudioDown = true;
                }
              }
              prev.set(key, { bytes: report.bytesReceived, timestamp: now });
            }

            if (kind === 'video') {
              totalPacketsReceived += report.packetsReceived || 0;
              totalPacketsLost += report.packetsLost || 0;

              if (prevEntry) {
                const deltaBits = (report.bytesReceived - prevEntry.bytes) * 8;
                const deltaMs = now - prevEntry.timestamp;
                if (deltaMs > 0) {
                  const bitrate = deltaBits / deltaMs;
                  // Only accumulate when bitrate > 0 — filters stale inbound-rtp
                  if (bitrate > 0) {
                    totalVideoDown += bitrate;
                    hasVideoDown = true;
                  }
                }
              }
              prev.set(key, { bytes: report.bytesReceived, timestamp: now });
            }
          }

          // ── Server address from remote-candidate ──
          // Safari may leave `address` empty but populate the legacy `ip` field
          if (report.type === 'remote-candidate' && !result.serverAddress) {
            const addr = report.address || report.ip;
            if (addr) {
              result.serverAddress = addr;
              result.protocol = report.protocol ?? null;
              result.candidateType = report.candidateType ?? null;
            }
          }
        });

        // Safari fallback: look up remote candidate by ID from candidate-pair
        if (!result.serverAddress && selectedCandidatePairRemoteId) {
          const remoteCandidate = reports.get(selectedCandidatePairRemoteId);
          if (remoteCandidate) {
            const addr = remoteCandidate.address || remoteCandidate.ip;
            if (addr) {
              result.serverAddress = addr;
              result.protocol = remoteCandidate.protocol ?? null;
              result.candidateType = remoteCandidate.candidateType ?? null;
            }
          }
        }
      }

      // Safari fallback: resolution from MediaStreamTrack.getSettings()
      // Safari omits frameWidth/frameHeight from outbound-rtp stats entirely
      if (!result.resolution && result.videoUp !== null && result.videoUp > 0) {
        const localPart = room.localParticipant;
        for (const pub of localPart.trackPublications.values()) {
          if (pub.source === Track.Source.Camera || pub.source === Track.Source.ScreenShare) {
            const mt = pub.track?.mediaStreamTrack;
            if (mt && mt.readyState === 'live') {
              const s = mt.getSettings();
              if (s.width && s.height) {
                result.resolution = `${s.width}\u00d7${s.height}`;
                result.fps = s.frameRate ? Math.round(s.frameRate) : null;
                break;
              }
            }
          }
        }
      }

      // Finalize aggregated inbound metrics
      if (hasAudioDown) result.audioDown = totalAudioDown;
      if (hasVideoDown) result.videoDown = totalVideoDown;

      const totalPackets = totalPacketsReceived + totalPacketsLost;
      if (totalPackets > 0) {
        result.packetLoss = (totalPacketsLost / totalPackets) * 100;
      }

      setStats(result);
    };

    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [open]);

  if (!open) return null;

  const room = getActiveRoom();
  const hasVideo = stats && (
    (stats.videoUp !== null && stats.videoUp > 0) ||
    (stats.videoDown !== null && stats.videoDown > 0) ||
    stats.resolution !== null
  );

  const Row = ({ label, value, colorClass }: { label: string; value: string; colorClass?: string }) => (
    <div className="flex items-center justify-between py-[3px]">
      <span className="text-[12px] text-discord-text-muted">{label}</span>
      <span className={`text-[12px] font-medium ${colorClass ?? 'text-discord-text-secondary'}`}>{value}</span>
    </div>
  );

  const Divider = () => <div className="border-t border-[#2b2d31] my-1" />;

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-[300px] bg-[#1e1f22] rounded-lg shadow-lg border border-[#111214] z-50 overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-[#111214]">
        <span className="text-[14px] font-bold text-discord-text-primary">Connection Info</span>
      </div>

      <div className="px-3 py-2">
        {!room ? (
          <div className="text-[12px] text-discord-text-muted py-2 text-center">Not connected</div>
        ) : !stats ? (
          <div className="text-[12px] text-discord-text-muted py-2 text-center">Gathering stats...</div>
        ) : (
          <>
            {/* Network */}
            <Row
              label="Ping"
              value={stats.ping !== null ? `${stats.ping} ms` : '\u2014'}
              colorClass={stats.ping !== null ? pingColor(stats.ping) : undefined}
            />
            <Row
              label="Packet Loss"
              value={stats.packetLoss !== null ? `${stats.packetLoss.toFixed(1)}%` : '\u2014'}
              colorClass={stats.packetLoss !== null ? lossColor(stats.packetLoss) : undefined}
            />
            <Row
              label="Jitter"
              value={stats.jitter !== null ? `${stats.jitter} ms` : '\u2014'}
              colorClass={stats.jitter !== null ? jitterColor(stats.jitter) : undefined}
            />

            <Divider />

            {/* Bitrates */}
            <Row label="Audio \u2191" value={formatBitrate(stats.audioUp)} />
            <Row label="Audio \u2193" value={formatBitrate(stats.audioDown)} />
            {hasVideo && (
              <>
                <Row label="Video \u2191" value={formatBitrate(stats.videoUp)} />
                <Row label="Video \u2193" value={formatBitrate(stats.videoDown)} />
              </>
            )}

            <Divider />

            {/* Codec + media info */}
            <Row
              label="Codec"
              value={[stats.audioCodec, stats.videoCodec].filter(Boolean).join(' / ') || '\u2014'}
            />
            {hasVideo && (
              <>
                <Row
                  label="Resolution"
                  value={stats.resolution ? `${stats.resolution}${stats.fps ? ` @${stats.fps}` : ''}` : '\u2014'}
                />
                <Row
                  label="Quality"
                  value={stats.qualityLimitation ?? '\u2014'}
                />
              </>
            )}

            <Divider />

            {/* Server */}
            <Row label="Server" value={stats.serverAddress ?? '\u2014'} />
            <Row
              label="Protocol"
              value={
                stats.protocol
                  ? `${stats.protocol}${stats.candidateType ? ` (${stats.candidateType})` : ''}`
                  : '\u2014'
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
