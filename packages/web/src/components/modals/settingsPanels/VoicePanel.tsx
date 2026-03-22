import { useVoiceStore } from '../../../stores/voiceStore';
import { Toggle } from '../../ui/Toggle';

export function VoicePanel() {
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const rnnoiseEnabled = useVoiceStore((s) => s.rnnoiseEnabled);
  const setEchoCancellation = useVoiceStore((s) => s.setEchoCancellation);
  const setAutoGainControl = useVoiceStore((s) => s.setAutoGainControl);
  const setRnnoiseEnabled = useVoiceStore((s) => s.setRnnoiseEnabled);
  const soundEffectVolume = useVoiceStore((s) => s.soundEffectVolume);
  const setSoundEffectVolume = useVoiceStore((s) => s.setSoundEffectVolume);

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">Voice</h2>
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          Volume
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="py-1">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-txt-primary">Sound Effects Volume</div>
              <div className="text-xs text-txt-tertiary tabular-nums">{soundEffectVolume}%</div>
            </div>
            <input
              type="range"
              min={0}
              max={200}
              value={soundEffectVolume}
              onChange={(e) => setSoundEffectVolume(Number(e.target.value))}
              className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-surface-base [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md"
              style={{
                background: `linear-gradient(to right, rgb(var(--accent-primary)) 0%, rgb(var(--accent-primary)) ${soundEffectVolume / 2}%, rgb(var(--interactive-muted)) ${soundEffectVolume / 2}%, rgb(var(--interactive-muted)) 100%)`,
              }}
            />
          </div>
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          Voice Processing
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-txt-primary">AI Noise Suppression</div>
              <div className="text-xs text-txt-tertiary">ML-based noise removal (RNNoise) — filters keyboard, fans, and background noise</div>
            </div>
            <Toggle enabled={rnnoiseEnabled} onChange={setRnnoiseEnabled} />
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-txt-primary">Echo Cancellation</div>
              <div className="text-xs text-txt-tertiary">Removes echo when using speakers</div>
            </div>
            <Toggle enabled={echoCancellation} onChange={setEchoCancellation} />
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-txt-primary">Auto Gain Control</div>
              <div className="text-xs text-txt-tertiary">Auto-adjusts mic volume — can cause voice ducking during streams</div>
            </div>
            <Toggle enabled={autoGainControl} onChange={setAutoGainControl} />
          </div>
        </div>
      </div>
    </div>
  );
}
