import { handleTextVoiceRequest } from '../../web/src/audio/textVoiceCore';
(window as any).localTextVoiceEngine.onRequest(handleTextVoiceRequest);
