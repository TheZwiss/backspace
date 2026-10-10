import { TranslationError } from './validation';
export type TranslationFetch = typeof fetch;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
async function readResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new TranslationError('invalid-response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new TranslationError('invalid-response');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function requestText(options: {
  url: string;
  init?: RequestInit;
  maxBytes?: number;
  fetcher: TranslationFetch;
}): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  try {
    const response = await options.fetcher(options.url, {
      ...options.init,
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Do not surface provider error bodies: they may echo the key, source text or request headers.
    if (!response.ok) {
      await response.body?.cancel();
      throw new TranslationError('http', response.status);
    }
    return await readResponse(response, maxBytes);
  } catch (error) {
    if (error instanceof TranslationError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
      throw new TranslationError('timeout');
    throw new TranslationError('network');
  }
}
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TranslationError('invalid-response');
  }
}
