import { useEffect, useRef, useState } from 'react';
import type { VoiceConnectionQuality } from '../stores/voiceStore';

export type StreamHealthWarning =
  | 'publisherNetwork'
  | 'publisherCpu'
  | 'viewerNetwork'
  | 'reconnecting'
  | 'unknown';

interface StreamHealthSample {
  reconnecting: boolean;
  isLocal: boolean;
  publisherConnectionQuality: VoiceConnectionQuality;
  localConnectionQuality: VoiceConnectionQuality;
  outboundReason: string | null;
  packetLoss: number | null;
  jitter: number | null;
  freezeCountDelta: number | null;
}

export function classifyStreamHealth(sample: StreamHealthSample): StreamHealthWarning | null {
  if (sample.reconnecting) return 'reconnecting';

  const publisherBad = sample.publisherConnectionQuality === 'poor'
    || sample.publisherConnectionQuality === 'lost'
    || sample.outboundReason === 'bandwidth'
    || sample.outboundReason === 'cpu';
  const viewerBad = !sample.isLocal && (
    sample.localConnectionQuality === 'poor'
    || sample.localConnectionQuality === 'lost'
    || (sample.packetLoss ?? 0) > 5
    || (sample.jitter ?? 0) > 80
    || (sample.freezeCountDelta ?? 0) > 0
  );

  if (publisherBad && viewerBad) return 'unknown';
  if (sample.outboundReason === 'cpu') return 'publisherCpu';
  if (publisherBad) return 'publisherNetwork';
  if (viewerBad) return 'viewerNetwork';
  return null;
}

/** Debounce sampled degradation while surfacing an explicit reconnect immediately. */
export function useStreamHealthWarning(
  candidate: StreamHealthWarning | null,
  sampleToken: unknown,
): StreamHealthWarning | null {
  const [warning, setWarning] = useState<StreamHealthWarning | null>(null);
  const warningRef = useRef<StreamHealthWarning | null>(null);
  const badSamples = useRef(0);
  const stableTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (candidate) {
      if (stableTimer.current) clearTimeout(stableTimer.current);
      stableTimer.current = null;

      if (candidate === 'reconnecting') {
        badSamples.current = 3;
        warningRef.current = candidate;
        setWarning(candidate);
        return;
      }

      badSamples.current += 1;
      if (badSamples.current >= 3) {
        warningRef.current = candidate;
        setWarning(candidate);
      }
      return;
    }

    badSamples.current = 0;
    if (warningRef.current && !stableTimer.current) {
      stableTimer.current = setTimeout(() => {
        stableTimer.current = null;
        warningRef.current = null;
        setWarning(null);
      }, 5000);
    }
  }, [candidate, sampleToken]);

  useEffect(() => () => {
    if (stableTimer.current) clearTimeout(stableTimer.current);
  }, []);

  return warning;
}
