import { webTextVoice } from './webTextVoice';

export function getLocalTextVoiceProvider() {
  return typeof window !== 'undefined' && typeof window.backspace?.synthesizeTextVoice === 'function' ? window.backspace : webTextVoice;
}

export function supportsLocalTextVoice(): boolean {
  return typeof window !== 'undefined' && (typeof window.backspace?.synthesizeTextVoice === 'function' ||
    (!!window.isSecureContext && typeof Worker !== 'undefined' && typeof crypto.subtle !== 'undefined'));
}

export async function synthesizeLocalTextVoice(text: string, voice: string, speed: number, signal: AbortSignal): Promise<ArrayBuffer> {
  if (!supportsLocalTextVoice()) throw new Error('desktop-text-voice-required');
  if (signal.aborted) throw new DOMException('Speech stopped', 'AbortError');
  const result = await getLocalTextVoiceProvider().synthesizeTextVoice!(text, voice, speed);
  if (signal.aborted) throw new DOMException('Speech stopped', 'AbortError');
  return result.audio;
}
