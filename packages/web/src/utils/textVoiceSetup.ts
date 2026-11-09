import { SPEECH_MODELS, speechRecognition, useDictationStore } from '../platform/speechRecognition';
import { getLocalTextVoiceProvider } from '../platform/textVoice';
import { useVoiceStore } from '../stores/voiceStore';

export type ProcessingDevice = 'auto' | 'cpu' | 'gpu';

/** Approximate download of the voice (speech synthesis) model, per processing choice. */
const SYNTHESIS_DOWNLOAD_MB: Record<ProcessingDevice, number> = { auto: 95, cpu: 95, gpu: 330 };

/**
 * Speech synthesis and dictation each keep a processing choice (CPU / GPU /
 * automatic). The user sees a single one, so every change goes to both.
 */
export function setProcessingDevice(device: ProcessingDevice): void {
  useVoiceStore.getState().setTextVoiceDevice(device);
  useDictationStore.getState().setDevice(device);
}

/** Megabytes still to download for the dictation model (0 once installed). */
export function dictationDownloadMb(): number {
  const { model, installed } = useDictationStore.getState();
  if (installed.includes(model)) return 0;
  const spec = SPEECH_MODELS.find((item) => item.id === model);
  if (!spec) return 0;
  return Math.ceil(spec.assets.reduce((sum, asset) => sum + asset.bytes, 0) / 1024 / 1024);
}

/** Total first-use download shown to the user: dictation model plus the synthesized voice. */
export function totalDownloadMb(device: ProcessingDevice): number {
  return dictationDownloadMb() + SYNTHESIS_DOWNLOAD_MB[device];
}

/** True once the dictation model is on this device: the user has already done the first-use setup. */
export function isSetupDone(): boolean {
  const { model, installed } = useDictationStore.getState();
  return installed.includes(model);
}

/**
 * First-use setup in one step: download the dictation model when missing,
 * then download/load the synthesized voice. Rejects on the first failure so
 * the caller can show one error and let the user retry the same button.
 */
export async function setupTextVoice(): Promise<void> {
  const dictation = useDictationStore.getState();
  if (!dictation.installed.includes(dictation.model)) {
    await speechRecognition.install();
    if (!isSetupDone()) throw new Error('download-failed');
  }
  await getLocalTextVoiceProvider().prepareTextVoice!(useVoiceStore.getState().textVoiceDevice);
}
