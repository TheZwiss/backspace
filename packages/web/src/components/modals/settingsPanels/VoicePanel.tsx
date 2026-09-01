import { useVoiceStore } from '../../../stores/voiceStore';
import { Toggle } from '../../ui/Toggle';
import { VideoSection } from './VideoSection';
import { AudioInputSection } from './AudioInputSection';
import { AudioOutputSection } from './AudioOutputSection';
import { Trans } from 'react-i18next';

export function VoicePanel() {
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const rnnoiseEnabled = useVoiceStore((s) => s.rnnoiseEnabled);
  const setEchoCancellation = useVoiceStore((s) => s.setEchoCancellation);
  const setAutoGainControl = useVoiceStore((s) => s.setAutoGainControl);
  const setRnnoiseEnabled = useVoiceStore((s) => s.setRnnoiseEnabled);
  const soundEffectVolume = useVoiceStore((s) => s.soundEffectVolume);
  const setSoundEffectVolume = useVoiceStore((s) => s.setSoundEffectVolume);
  const messageSoundAllChannels = useVoiceStore((s) => s.messageSoundAllChannels);
  const setMessageSoundAllChannels = useVoiceStore((s) => s.setMessageSoundAllChannels);

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6"><Trans i18nKey="ui.VoicePanel.voiceVideo">Voice &amp; Video</Trans></h2>

      <AudioInputSection />
      <AudioOutputSection />

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          <Trans i18nKey="ui.VoicePanel.volume">Volume</Trans>
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="py-1">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-txt-primary"><Trans i18nKey="ui.VoicePanel.soundEffectsVolume">Sound Effects Volume</Trans></div>
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
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-txt-primary"><Trans i18nKey="ui.VoicePanel.playSoundForEveryMessage">Play sound for every message</Trans></div>
              <div className="text-xs text-txt-tertiary">
                <Trans i18nKey="ui.VoicePanel.offDefaultOnlyDMsAndMessagesThatMention">Off (default): only DMs and messages that mention you. On: every channel.</Trans>
              </div>
            </div>
            <Toggle enabled={messageSoundAllChannels} onChange={setMessageSoundAllChannels} />
          </div>
        </div>
      </div>

      <VideoSection />

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          <Trans i18nKey="ui.VoicePanel.voiceProcessing">Voice Processing</Trans>
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-txt-primary"><Trans i18nKey="ui.VoicePanel.aiNoiseSuppression">AI Noise Suppression</Trans></div>
              <div className="text-xs text-txt-tertiary"><Trans i18nKey="ui.VoicePanel.mlBasedNoiseRemovalRNNoiseFiltersKeyboardFans">ML-based noise removal (RNNoise) — filters keyboard, fans, and background noise</Trans></div>
            </div>
            <Toggle enabled={rnnoiseEnabled} onChange={setRnnoiseEnabled} />
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-txt-primary"><Trans i18nKey="ui.VoicePanel.echoCancellation">Echo Cancellation</Trans></div>
              <div className="text-xs text-txt-tertiary"><Trans i18nKey="ui.VoicePanel.cancelsEchoFromYourSpeakersFeedingBackInto">Cancels echo from your speakers feeding back into the mic. Always on for voice channels and calls.</Trans></div>
            </div>
            <Toggle enabled={echoCancellation} onChange={setEchoCancellation} />
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-txt-primary"><Trans i18nKey="ui.VoicePanel.autoGainControl">Auto Gain Control</Trans></div>
              <div className="text-xs text-txt-tertiary"><Trans i18nKey="ui.VoicePanel.autoAdjustsMicVolumeCanCauseVoiceDucking">Auto-adjusts mic volume — can cause voice ducking during streams</Trans></div>
            </div>
            <Toggle enabled={autoGainControl} onChange={setAutoGainControl} />
          </div>
        </div>
      </div>
    </div>
  );
}
