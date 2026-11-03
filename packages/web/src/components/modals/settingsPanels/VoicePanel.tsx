import { TextVoiceSettings } from '../../voice/TextVoice';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';
import { VideoSection } from './VideoSection';
import { AudioInputSection } from './AudioInputSection';
import { AudioOutputSection } from './AudioOutputSection';

export function VoicePanel() {
  const { t } = useTranslation(['settings']);
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const rnnoiseEnabled = useVoiceStore((s) => s.rnnoiseEnabled);
  const setEchoCancellation = useVoiceStore((s) => s.setEchoCancellation);
  const setAutoGainControl = useVoiceStore((s) => s.setAutoGainControl);
  const setRnnoiseEnabled = useVoiceStore((s) => s.setRnnoiseEnabled);
  const pipEnabled = useVoiceStore((s) => s.pipEnabled);
  const setPipEnabled = useVoiceStore((s) => s.setPipEnabled);
  // The floating window is mounted only by the desktop layout (AppLayout), and
  // the mobile Voice settings screen renders this same panel, so the setting is
  // offered only where it has an effect.
  const textVoiceEnabled = useVoiceStore((s) => s.textVoiceEnabled);
  const isMobile = useUIStore((s) => s.isMobile);

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">{t('settings:voice.title')}</h2>

      <TextVoiceSettings />
      {!textVoiceEnabled && <AudioInputSection />}
      <AudioOutputSection />

      {!isMobile && (
        <div>
          <div className="text-ui-caption font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            {t('settings:voice.pip.sectionTitle')}
          </div>
          <div className="settings-section">
            <div className="flex items-center justify-between py-2">
              <div className="flex-1 mr-4">
                <div className="text-sm text-txt-primary">{t('settings:voice.pip.showOnSwitch.label')}</div>
                <div className="text-xs text-txt-tertiary">{t('settings:voice.pip.showOnSwitch.description')}</div>
              </div>
              <Toggle
                enabled={pipEnabled}
                onChange={setPipEnabled}
                ariaLabel={t('settings:voice.pip.showOnSwitch.label')}
              />
            </div>
          </div>
        </div>
      )}

      <VideoSection />

      <div>
        <div className="text-ui-caption font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('settings:voice.processing.sectionTitle')}
        </div>
        <div className="settings-section">
          <div className="flex items-center justify-between py-2">
            <div className="flex-1 mr-4">
              <div className="text-sm text-txt-primary">{t('settings:voice.processing.noiseSuppression.label')}</div>
              <div className="text-xs text-txt-tertiary">{t('settings:voice.processing.noiseSuppression.description')}</div>
            </div>
            <Toggle enabled={rnnoiseEnabled} onChange={setRnnoiseEnabled} />
          </div>

          <div className="flex items-center justify-between py-2">
            <div className="flex-1 mr-4">
              <div className="text-sm text-txt-primary">{t('settings:voice.processing.echoCancellation.label')}</div>
              <div className="text-xs text-txt-tertiary">{t('settings:voice.processing.echoCancellation.description')}</div>
            </div>
            <Toggle enabled={echoCancellation} onChange={setEchoCancellation} />
          </div>

          <div className="flex items-center justify-between py-2">
            <div className="flex-1 mr-4">
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
