import { lookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { request, type RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import { TranslationError, type TranslationFetch } from '@backspace/translation';
import { isPrivateIp } from '../utils/ssrf.js';

export function serverProviderUrl(input: string): URL {
  const url = new URL(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (isIP(hostname) && isPrivateIp(hostname))) {
    throw new TranslationError('unsafe-endpoint');
  }
  return url;
}

/** Validate at socket lookup, not in a separate preflight that permits DNS rebinding. */
export const publicProviderLookup: NonNullable<RequestOptions['lookup']> = (hostname, options, callback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) { callback(error, [], 0); return; }
    if (!addresses.length || addresses.some((entry: LookupAddress) => isPrivateIp(entry.address))) {
      callback(new TranslationError('unsafe-endpoint'), [], 0);
      return;
    }
    const first = addresses[0]!;
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

/** No redirects, ambient cookies, or proxy environment inheritance for user-selected endpoints. */
export const serverProviderFetch: TranslationFetch = async (input, init = {}) => {
  const url = serverProviderUrl(String(input));
  const headers = Object.fromEntries(new Headers(init.headers));
  if (init.body !== undefined && typeof init.body !== 'string') throw new TranslationError('invalid-input');
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      method: init.method ?? 'GET', headers, signal: init.signal ?? undefined,
      lookup: publicProviderLookup, agent: false,
    }, (res) => {
      const status = res.statusCode!;
      // Node accepts nonstandard status codes that Response rejects. Do not throw from an async callback.
      if (status < 200 || status > 599) {
        res.destroy();
        reject(new TranslationError('invalid-response'));
        return;
      }
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      // The shared transport enforces response size, timeout and HTTP success; redirects stay responses.
      // Error/redirect bodies may echo credentials; close them before adapting the stream.
      const empty = status >= 300 || status === 204 || status === 205;
      if (empty) res.destroy();
      resolve(new Response(empty ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, {
        status, headers: responseHeaders,
      }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
};
