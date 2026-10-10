import type { TranslationBridge, TranslationReply } from '@backspace/shared/translation';
import { readServerReply } from './serverReply';

async function readHttpReply(response: Response): Promise<TranslationReply> {
  if (response.status === 401 || response.status === 403) return { ok: false, code: 'untrusted-sender' };
  if (response.status === 404) return { ok: false, code: 'server-not-configured' };
  if (response.status === 429) return { ok: false, code: 'http', status: 429 };
  try {
    const reply = readServerReply(await response.json());
    return !response.ok && reply.ok ? { ok: false, code: 'http', status: response.status } : reply;
  } catch {
    return { ok: false, code: 'invalid-response' };
  }
}

/** Match the existing /api login session: never use the currently viewed federated space origin. */
export const serverTranslationBridge: TranslationBridge = {
  async command(command) {
    const origin = new URL(window.location.href);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) {
      return { ok: false, code: 'insecure-transport' };
    }
    const token = localStorage.getItem('backspace_token');
    if (!token) return { ok: false, code: 'untrusted-sender' };
    try {
      const response = await fetch(origin.origin + '/api/translation/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(command),
        credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      });
      return await readHttpReply(response);
    } catch (error) {
      const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      return { ok: false, code: timeout ? 'timeout' : 'network' };
    }
  },
};
