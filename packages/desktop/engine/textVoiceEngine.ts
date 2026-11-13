import { handleTextVoiceRequest } from '../../web/src/audio/textVoiceCore';
declare global {
  interface Window {
    localTextVoiceEngine: { onRequest(callback: (operation: string, data: unknown) => Promise<unknown>): void };
  }
}
window.localTextVoiceEngine.onRequest(handleTextVoiceRequest);
