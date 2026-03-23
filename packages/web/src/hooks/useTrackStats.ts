import { useState, useEffect, useRef } from 'react';
import { Track } from 'livekit-client';
import { getActiveRoom } from './useLiveKit';
import { discoverPeerConnections } from '../utils/livekitInternals';

// ── Types ──

type TrackSource = 'microphone' | 'camera' | 'screen_share' | 'screen_share_audio' | 'unknown';
type TrackDirection = 'send' | 'recv';

export interface AudioTrackStat {
  key: string;
  direction: TrackDirection;
  source: TrackSource;
  participantName: string | null;
  bitrate: number;
  codec: string | null;
  packetLoss: number | null;
  jitter: number | null;
}

export interface VideoTrackStat {
  key: string;
  direction: TrackDirection;
  source: TrackSource;
  participantName: string | null;
  bitrate: number;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  qualityLimitation: string | null;
  simulcastLayer: string | null;
}

/**
 * Network-level WebRTC stats for the active ICE transport.
 *
 * `serverAddress`, `protocol`, and `candidateType` may legitimately remain null
 * on strict LANs where Chrome's mDNS IP obfuscation masks candidate-pair addresses.
 * When ICE candidates use mDNS hostnames (e.g. "abcd-1234.local") instead of raw IPs,
 * the browser's stats API returns the obfuscated hostname and we cannot resolve the
 * underlying address. This is a known WebRTC platform limitation, not a bug in our code.
 */
export interface NetworkStats {
  ping: number | null;
  packetLoss: number | null;
  jitter: number | null;
  serverAddress: string | null;
  protocol: string | null;
  candidateType: string | null;
}

export interface TrackStatsSnapshot {
  network: NetworkStats;
  audioTracks: AudioTrackStat[];
  videoTracks: VideoTrackStat[];
}

// ── Internal types ──

interface TrackIdentity {
  source: TrackSource;
  direction: TrackDirection;
  participantName: string | null;
}

interface PrevSample {
  bytes: number;
  frames: number;
  timestamp: number;
  packetsRecv: number;
  packetsLost: number;
}

// ── Helpers ──

function mapSource(lkSource: Track.Source): TrackSource {
  switch (lkSource) {
    case Track.Source.Microphone: return 'microphone';
    case Track.Source.Camera: return 'camera';
    case Track.Source.ScreenShare: return 'screen_share';
    case Track.Source.ScreenShareAudio: return 'screen_share_audio';
    default: return 'unknown';
  }
}

function parseUsername(identity: string): string {
  const parts = identity.split(':');
  return parts[1] ?? identity;
}

/** Determine media kind from a WebRTC stats report (handles both spec and legacy fields). */
function reportKind(report: any): 'audio' | 'video' | null {
  const k = report.kind ?? report.mediaType;
  if (k === 'audio' || k === 'video') return k;
  return null;
}

function inferSimulcastLayer(width: number | null, height: number | null): string | null {
  if (height !== null && height > 0) {
    if (height >= 1000) return 'High';
    if (height >= 700) return 'Medium';
    return 'Low';
  }
  if (width !== null && width > 0) return 'Low';
  return null;
}

// ── Hook ──

export function useTrackStats(enabled: boolean): TrackStatsSnapshot | null {
  const [snapshot, setSnapshot] = useState<TrackStatsSnapshot | null>(null);
  const prevSampleRef = useRef<Map<string, PrevSample>>(new Map());

  useEffect(() => {
    if (!enabled) {
      prevSampleRef.current.clear();
      setSnapshot(null);
      return;
    }

    const poll = async () => {
      const room = getActiveRoom();
      if (!room) {
        setSnapshot(null);
        return;
      }

      const pcs = discoverPeerConnections(room as any);
      if (pcs.length === 0) {
        setSnapshot(null);
        return;
      }

      const prev = prevSampleRef.current;
      const now = performance.now();

      // ── Step A: Network stats + codec map from pc.getStats() ──
      const network: NetworkStats = {
        ping: null,
        packetLoss: null,
        jitter: null,
        serverAddress: null,
        protocol: null,
        candidateType: null,
      };

      // Global codec map across all PCs
      const globalCodecMap = new Map<string, string>();

      for (const pc of pcs) {
        let reports: RTCStatsReport;
        try {
          reports = await pc.getStats();
        } catch {
          continue;
        }

        // Pass 1: Collect codecs, find transport's selected candidate pair
        let selectedPairId: string | null = null;
        reports.forEach((report: any) => {
          if (report.type === 'codec') {
            globalCodecMap.set(report.id, report.mimeType?.split('/')[1] ?? report.mimeType ?? '');
          }
          if (report.type === 'transport' && report.selectedCandidatePairId) {
            selectedPairId = report.selectedCandidatePairId;
          }
        });

        // Pass 2: Resolve active candidate pair (three-tier fallback)
        let activePair: any = null;
        if (selectedPairId) {
          // Tier 1: Spec-correct — transport points directly to the active pair
          activePair = reports.get(selectedPairId);
        }
        if (!activePair) {
          // Tier 2: Active-bytes heuristic — the pair carrying the most data IS
          // the active transport, regardless of state label or mDNS obfuscation
          let maxBytes = 0;
          reports.forEach((report: any) => {
            if (report.type === 'candidate-pair') {
              const total = (report.bytesSent ?? 0) + (report.bytesReceived ?? 0);
              if (total > maxBytes) {
                maxBytes = total;
                activePair = report;
              }
            }
          });
        }
        if (!activePair) {
          // Tier 3: Legacy fallback — first pair with state succeeded or in-progress
          reports.forEach((report: any) => {
            if (report.type === 'candidate-pair' && !activePair) {
              if (report.state === 'succeeded' || report.state === 'in-progress') {
                activePair = report;
              }
            }
          });
        }

        // Pass 3: Extract network info from active pair
        if (activePair) {
          if (activePair.currentRoundTripTime != null) {
            network.ping = Math.round(activePair.currentRoundTripTime * 1000);
          }
          if (!network.serverAddress && activePair.remoteCandidateId) {
            const remoteCandidate = reports.get(activePair.remoteCandidateId);
            if (remoteCandidate) {
              const addr = remoteCandidate.address || remoteCandidate.ip;
              if (addr) {
                network.serverAddress = addr;
                network.protocol = remoteCandidate.protocol ?? null;
                network.candidateType = remoteCandidate.candidateType ?? null;
              }
            }
          }
        }
      }

      // ── Step B: Build TrackIdentityMap ──
      const identityMap = new Map<string, TrackIdentity>();

      // Local tracks
      for (const pub of room.localParticipant.trackPublications.values()) {
        const mst = pub.track?.mediaStreamTrack;
        if (mst) {
          identityMap.set(mst.id, {
            source: mapSource(pub.source),
            direction: 'send',
            participantName: null,
          });
        }
      }

      // Remote tracks
      for (const [, rp] of room.remoteParticipants) {
        const name = parseUsername(rp.identity);
        for (const pub of rp.trackPublications.values()) {
          const mst = pub.track?.mediaStreamTrack;
          if (mst) {
            identityMap.set(mst.id, {
              source: mapSource(pub.source),
              direction: 'recv',
              participantName: name,
            });
          }
        }
      }

      // ── Step C & D: Per-sender and per-receiver stats ──
      const audioTracks: AudioTrackStat[] = [];
      const videoTracks: VideoTrackStat[] = [];
      let totalPacketsReceived = 0;
      let totalPacketsLost = 0;
      const seenKeys = new Set<string>();

      for (const pc of pcs) {
        // Process senders (outbound)
        for (const sender of pc.getSenders()) {
          if (!sender.track) continue;

          const identity = identityMap.get(sender.track.id);
          if (!identity) continue;

          let senderStats: RTCStatsReport;
          try {
            senderStats = await sender.getStats();
          } catch {
            continue;
          }

          // Build per-sender codec map
          const senderCodecMap = new Map<string, string>();
          senderStats.forEach((report: any) => {
            if (report.type === 'codec') {
              senderCodecMap.set(report.id, report.mimeType?.split('/')[1] ?? report.mimeType ?? '');
            }
          });

          senderStats.forEach((report: any) => {
            if (report.type !== 'outbound-rtp') return;

            const kind = reportKind(report);
            if (!kind) return;

            const ssrcKey = `out-${report.ssrc}`;
            if (seenKeys.has(ssrcKey)) return;
            seenKeys.add(ssrcKey);

            const prevEntry = prev.get(ssrcKey);
            const deltaMs = prevEntry ? now - prevEntry.timestamp : 0;
            const deltaSeconds = deltaMs / 1000;

            // Delta bitrate
            let bitrate = 0;
            if (prevEntry && deltaMs > 0) {
              bitrate = ((report.bytesSent - prevEntry.bytes) * 8) / deltaMs; // kbps
            }

            // Codec: try sender-scoped first, then global fallback
            let codec: string | null = null;
            if (report.codecId) {
              codec = senderCodecMap.get(report.codecId) ?? globalCodecMap.get(report.codecId) ?? null;
            }

            if (kind === 'audio') {
              prev.set(ssrcKey, {
                bytes: report.bytesSent,
                frames: 0,
                timestamp: now,
                packetsRecv: 0,
                packetsLost: 0,
              });

              if (bitrate > 0) {
                audioTracks.push({
                  key: ssrcKey,
                  direction: 'send',
                  source: identity.source,
                  participantName: null,
                  bitrate,
                  codec,
                  packetLoss: null,
                  jitter: null,
                });
              }
            }

            if (kind === 'video') {
              const framesEncoded = report.framesEncoded ?? 0;
              const prevFrames = prevEntry?.frames ?? 0;
              const deltaFrames = framesEncoded - prevFrames;
              const fps = (prevEntry && deltaSeconds > 0) ? Math.round(deltaFrames / deltaSeconds) : null;

              let width: number | null = report.frameWidth > 0 ? report.frameWidth : null;
              let height: number | null = report.frameHeight > 0 ? report.frameHeight : null;

              // Safari fallback: resolution from MediaStreamTrack.getSettings()
              const senderTrack = sender.track;
              if (width === null && senderTrack && senderTrack.readyState === 'live') {
                const settings = senderTrack.getSettings();
                if (settings.width && settings.height) {
                  width = settings.width;
                  height = settings.height;
                }
              }

              prev.set(ssrcKey, {
                bytes: report.bytesSent,
                frames: framesEncoded,
                timestamp: now,
                packetsRecv: 0,
                packetsLost: 0,
              });

              if (bitrate > 0 || (width !== null && height !== null)) {
                videoTracks.push({
                  key: ssrcKey,
                  direction: 'send',
                  source: identity.source,
                  participantName: null,
                  bitrate,
                  codec,
                  width,
                  height,
                  fps,
                  qualityLimitation: report.qualityLimitationReason ?? null,
                  simulcastLayer: null,
                });
              }
            }
          });
        }

        // Process receivers (inbound)
        for (const receiver of pc.getReceivers()) {
          if (!receiver.track) continue;

          const identity = identityMap.get(receiver.track.id);
          if (!identity) continue;

          let receiverStats: RTCStatsReport;
          try {
            receiverStats = await receiver.getStats();
          } catch {
            continue;
          }

          // Build per-receiver codec map
          const recvCodecMap = new Map<string, string>();
          receiverStats.forEach((report: any) => {
            if (report.type === 'codec') {
              recvCodecMap.set(report.id, report.mimeType?.split('/')[1] ?? report.mimeType ?? '');
            }
          });

          receiverStats.forEach((report: any) => {
            if (report.type !== 'inbound-rtp') return;

            const kind = reportKind(report);
            if (!kind) return;

            const ssrcKey = `in-${report.ssrc}`;
            if (seenKeys.has(ssrcKey)) return;
            seenKeys.add(ssrcKey);

            const prevEntry = prev.get(ssrcKey);
            const deltaMs = prevEntry ? now - prevEntry.timestamp : 0;
            const deltaSeconds = deltaMs / 1000;

            // Delta bitrate
            let bitrate = 0;
            if (prevEntry && deltaMs > 0) {
              bitrate = ((report.bytesReceived - prevEntry.bytes) * 8) / deltaMs; // kbps
            }

            // Packet loss
            const packetsRecv = report.packetsReceived ?? 0;
            const packetsLost = report.packetsLost ?? 0;
            totalPacketsReceived += packetsRecv;
            totalPacketsLost += packetsLost;

            let perTrackLoss: number | null = null;
            if (prevEntry) {
              const deltaRecv = packetsRecv - prevEntry.packetsRecv;
              const deltaLost = packetsLost - prevEntry.packetsLost;
              const deltaTotal = deltaRecv + deltaLost;
              if (deltaTotal > 0) {
                perTrackLoss = (deltaLost / deltaTotal) * 100;
              }
            }

            // Jitter
            const jitter = report.jitter != null ? Math.round(report.jitter * 1000) : null;

            // Codec
            let codec: string | null = null;
            if (report.codecId) {
              codec = recvCodecMap.get(report.codecId) ?? globalCodecMap.get(report.codecId) ?? null;
            }

            if (kind === 'audio') {
              prev.set(ssrcKey, {
                bytes: report.bytesReceived,
                frames: 0,
                timestamp: now,
                packetsRecv: packetsRecv,
                packetsLost: packetsLost,
              });

              // Set network jitter from first inbound audio
              if (network.jitter === null && jitter !== null) {
                network.jitter = jitter;
              }

              if (bitrate > 0) {
                audioTracks.push({
                  key: ssrcKey,
                  direction: 'recv',
                  source: identity.source,
                  participantName: identity.participantName,
                  bitrate,
                  codec,
                  packetLoss: perTrackLoss,
                  jitter,
                });
              }
            }

            if (kind === 'video') {
              const framesDecoded = report.framesDecoded ?? 0;
              const prevFrames = prevEntry?.frames ?? 0;
              const deltaFrames = framesDecoded - prevFrames;
              const fps = (prevEntry && deltaSeconds > 0) ? Math.round(deltaFrames / deltaSeconds) : null;

              const width: number | null = report.frameWidth > 0 ? report.frameWidth : null;
              const height: number | null = report.frameHeight > 0 ? report.frameHeight : null;

              prev.set(ssrcKey, {
                bytes: report.bytesReceived,
                frames: framesDecoded,
                timestamp: now,
                packetsRecv: packetsRecv,
                packetsLost: packetsLost,
              });

              if (bitrate > 0 || (width !== null && height !== null)) {
                videoTracks.push({
                  key: ssrcKey,
                  direction: 'recv',
                  source: identity.source,
                  participantName: identity.participantName,
                  bitrate,
                  codec,
                  width,
                  height,
                  fps,
                  qualityLimitation: null,
                  simulcastLayer: inferSimulcastLayer(width, height),
                });
              }
            }
          });
        }
      }

      // ── Step E: Aggregate packet loss ──
      const totalPackets = totalPacketsReceived + totalPacketsLost;
      if (totalPackets > 0) {
        network.packetLoss = (totalPacketsLost / totalPackets) * 100;
      }

      // ── Step F: Filter paused backup codec tracks ──
      // With backupCodec enabled, the publisher may have two concurrent outbound
      // video tracks for the same source (e.g. VP9 + H.264). When one is paused
      // by dynacast (0 bitrate), hide it if an active sibling exists.
      const filteredVideoTracks = videoTracks.filter((track) => {
        if (track.direction !== 'send' || track.bitrate > 0) return true;
        const hasActiveSibling = videoTracks.some(
          (other) =>
            other !== track &&
            other.direction === 'send' &&
            other.source === track.source &&
            other.bitrate > 0,
        );
        return !hasActiveSibling;
      });

      // ── Step G: Cleanup stale prevSample entries ──
      for (const key of prev.keys()) {
        if (!seenKeys.has(key)) {
          prev.delete(key);
        }
      }

      setSnapshot({ network, audioTracks, videoTracks: filteredVideoTracks });
    };

    poll();
    const interval = setInterval(poll, 1000);
    return () => clearInterval(interval);
  }, [enabled]);

  return snapshot;
}
