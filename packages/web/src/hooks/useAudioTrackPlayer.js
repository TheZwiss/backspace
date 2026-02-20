import { useRef, useEffect } from 'react';
import { AudioManager } from '../audio/AudioManager';
/**
 * Shared hybrid audio pipeline hook.
 *
 * Manages an <audio> element ref with two modes:
 *   - Standard mode (volume <= 1.0): uses native HTMLAudioElement volume
 *   - Boost mode (volume > 1.0): routes through Web Audio GainNode for amplification
 *
 * The caller must render: <audio ref={audioRef} autoPlay playsInline />
 */
export function useAudioTrackPlayer(opts) {
    const audioRef = useRef(null);
    const boostGainRef = useRef(null);
    const boostSourceRef = useRef(null);
    const { track, volume, muted } = opts;
    // Effect 1: Track attachment
    useEffect(() => {
        const audioEl = audioRef.current;
        if (!audioEl || !track) {
            if (audioEl)
                audioEl.srcObject = null;
            return;
        }
        const stream = new MediaStream([track]);
        // Only update if the stream actually changed to prevent interruptions
        if (audioEl.srcObject?.id !== stream.id) {
            audioEl.srcObject = stream;
            const tryPlay = async () => {
                try {
                    await audioEl.play();
                }
                catch (err) {
                    console.warn('[Audio] Autoplay blocked, retrying...', err);
                }
            };
            tryPlay();
        }
    }, [track]);
    // Effect 2: Volume management (hybrid native/Web Audio)
    useEffect(() => {
        const audioEl = audioRef.current;
        if (!audioEl || !track)
            return;
        if (muted) {
            audioEl.muted = true;
            return;
        }
        const audioManager = AudioManager.getInstance();
        const ctx = audioManager.getContext();
        const isBoosting = volume > 1.0;
        const isContextReady = ctx && ctx.state === 'running';
        if (isBoosting && isContextReady) {
            // --- BOOST MODE (>100%) ---
            // Setup pipeline if missing
            if (!boostGainRef.current && ctx) {
                const gain = ctx.createGain();
                const source = ctx.createMediaStreamSource(new MediaStream([track]));
                source.connect(gain);
                gain.connect(ctx.destination);
                boostGainRef.current = gain;
                boostSourceRef.current = source;
            }
            // Apply boosted gain
            if (boostGainRef.current && ctx) {
                boostGainRef.current.gain.setTargetAtTime(volume, ctx.currentTime, 0.01);
            }
            // MUTE the element so we don't double audio
            audioEl.muted = true;
        }
        else {
            // --- STANDARD MODE (0% - 100%) ---
            // Clean up boost pipeline if it exists
            if (boostSourceRef.current) {
                boostSourceRef.current.disconnect();
                boostSourceRef.current = null;
                boostGainRef.current = null;
            }
            audioEl.muted = false;
            audioEl.volume = Math.min(volume, 1.0);
            // Ensure it's playing (in case it was paused/blocked earlier)
            if (audioEl.paused) {
                audioEl.play().catch(() => { });
            }
        }
        return () => {
            if (boostSourceRef.current) {
                boostSourceRef.current.disconnect();
                boostSourceRef.current = null;
                boostGainRef.current = null;
            }
        };
    }, [volume, muted, track]);
    return audioRef;
}
