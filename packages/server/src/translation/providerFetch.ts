import { lookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { request, type RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import { isPrivateIp } from '../utils/ssrf.js';
import { TranslationFault } from './errors.js';

export type ProviderFetch = typeof fetch;

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

/**
 * Validates that a configured provider root URL is a public HTTPS URL with no
 * userinfo, query string, or fragment.
 */
export function validatePublicProviderBaseUrl(input: string): { normalizedBaseUrl: string; host: string } {
  const trimmed = stripTrailingSlashes(input.trim());
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TranslationFault('unsafe_endpoint');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    !hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (isIP(hostname) && isPrivateIp(hostname))
  ) {
    throw new TranslationFault('unsafe_endpoint');
  }
  return {
    normalizedBaseUrl: stripTrailingSlashes(url.toString()),
    host: url.host.toLowerCase(),
  };
}

export function validateProviderRequestUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TranslationFault('unsafe_endpoint');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    !hostname ||
    url.username ||
    url.password ||
    url.hash ||
    (isIP(hostname) && isPrivateIp(hostname))
  ) {
    throw new TranslationFault('unsafe_endpoint');
  }
  return url;
}

/**
 * Validates resolved DNS addresses inside the socket lookup itself so DNS
 * rebinding between preflight and connect cannot reach private networks.
 */
export const publicProviderLookup: NonNullable<RequestOptions['lookup']> = (hostname, options, callback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) {
      callback(error, [], 0);
      return;
    }
    if (!addresses.length || addresses.some((entry: LookupAddress) => isPrivateIp(entry.address))) {
      callback(new TranslationFault('unsafe_endpoint'), [], 0);
      return;
    }
    const first = addresses[0]!;
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

export const serverProviderFetch: ProviderFetch = async (input, init = {}) => {
  const url = validateProviderRequestUrl(String(input));
  const headers = Object.fromEntries(new Headers(init.headers));
  if (init.body !== undefined && typeof init.body !== 'string') {
    throw new TranslationFault('invalid_input');
  }
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? 'GET',
        headers,
        signal: init.signal ?? undefined,
        lookup: publicProviderLookup,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new TranslationFault('provider_failed'));
          return;
        }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) {
            responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
        }
        // Redirects and non-body responses are closed immediately; never follow redirects.
        const empty = status >= 300 || status === 204 || status === 205;
        if (empty) res.destroy();
        resolve(
          new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            headers: responseHeaders,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
};

export async function requestProviderText(options: {
  url: string;
  init?: RequestInit;
  maxBytes?: number;
  timeoutMs?: number;
  fetcher: ProviderFetch;
}): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await options.fetcher(options.url, {
      ...options.init,
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof TranslationFault) throw error;
    throw new TranslationFault('provider_failed');
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new TranslationFault('provider_failed', response.status);
  }
  if (!response.body) {
    throw new TranslationFault('provider_failed');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new TranslationFault('provider_failed');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TranslationFault) throw error;
    throw new TranslationFault('provider_failed');
  }
  return Buffer.concat(chunks).toString('utf8');
}
