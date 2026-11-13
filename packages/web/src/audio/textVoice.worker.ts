import { handleTextVoiceRequest } from './textVoiceCore';
const worker = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void };
self.onmessage = async (event: MessageEvent<{ id: number; operation: string; data: unknown }>) => {
  const { id, operation, data } = event.data;
  try {
    const result = await handleTextVoiceRequest(operation, data);
    const audio = typeof result === 'object' && result !== null && 'audio' in result ? result.audio : null;
    worker.postMessage({ id, ok: true, result }, audio instanceof ArrayBuffer ? [audio] : []);
  } catch (error) {
    worker.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'engine-failed' });
  }
};
