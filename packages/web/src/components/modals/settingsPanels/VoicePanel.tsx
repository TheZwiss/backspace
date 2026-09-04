import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useFormatters } from '../../../i18n/formatters';
import { Toggle } from '../../ui/Toggle';
import { VideoSection } from './VideoSection';
import { AudioInputSection } from './AudioInputSection';
import { AudioOutputSection } from './AudioOutputSection';

export function VoicePanel() {
  const { t } = useTranslation(['settings']);
  const f = useFormatters();
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
      <h2 className="text-lg font-semibold text-txt-primary mb-6">{t('settings:voice.title')}</h2>

      <AudioInputSection />
      <AudioOutputSection />

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('settings:voice.volume.sectionTitle')}
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="py-1">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-txt-primary">{t('settings:voice.volume.soundEffects.label')}</div>
              <div className="text-xs text-txt-tertiary tabular-nums">{f.formatPercent(soundEffectVolume)}</div>
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
              <div className="text-sm text-txt-primary">{t('settings:voice.volume.messageSound.label')}</div>
              <div className="text-xs text-txt-tertiary">
                {t('settings:voice.volume.messageSound.description')}
              </div>
            </div>
            <Toggle enabled={messageSoundAllChannels} onChange={setMessageSoundAllChannels} />
          </div>
        </div>
      </div>

      <VideoSection />

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('settings:voice.processing.sectionTitle')}
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-txt-primary">{t('settings:voice.processing.noiseSuppression.label')}</div>
              <div className="text-xs text-txt-tertiary">{t('settings:voice.processing.noiseSuppression.description')}</div>
            </div>
            <Toggle enabled={rnnoiseEnabled} onChange={setRnnoiseEnabled} />
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-txt-primary">{t('settings:voice.processing.echoCancellation.label')}</div>
              <div className="text-xs text-txt-tertiary">{t('settings:voice.processing.echoCancellation.description')}</div>
            </div>
            <Toggle enabled={echoCancellation} onChange={setEchoCancellation} />
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-txt-primary">{t('settings:voice.processing.autoGain.label')}</div>
              <div className="text-xs text-txt-tertiary">{t('settings:voice.processing.autoGain.description')}</div>
            </div>
            <Toggle enabled={autoGainControl} onChange={setAutoGainControl} />
          </div>
        </div>
      </div>
    </div>
  );
}
