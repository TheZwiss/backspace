import dns from 'dns';

export function isPrivateIp(ip: string): boolean {
  // IPv4
  if (ip.startsWith('127.') || ip.startsWith('0.') || ip === '0.0.0.0') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] ?? '', 10);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  return false;
}

/**
 * Validate that a URL is safe for outbound fetch (not private/internal).
 * Throws on invalid scheme, DNS failure, or private IP resolution.
 */
export async function validateExternalUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Invalid URL scheme');
  }

  let address: string;
  try {
    const result = await dns.promises.lookup(parsed.hostname);
    address = result.address;
  } catch {
    throw new Error('DNS lookup failed');
  }

  if (isPrivateIp(address)) {
    throw new Error('Private IP not allowed');
  }
}

const MAX_REDIRECTS = 5;

/**
 * SSRF-safe fetch. Validates the target URL and re-validates the destination of
 * every redirect hop before following it, so a hostile server cannot 30x-redirect
 * an outbound request to an internal address (loopback, link-local, RFC1918).
 *
 * Use this instead of bare `fetch()` for any request to a user- or peer-supplied
 * URL. Redirects are followed manually (Node/undici exposes the 3xx + Location
 * with `redirect: 'manual'`), capped at MAX_REDIRECTS.
 *
 * Residual: validateExternalUrl resolves DNS, then fetch resolves again — a
 * narrow DNS-rebinding TOCTOU window remains. Pinning the resolved IP at connect
 * time would close it but requires a custom dispatcher; the redirect re-check
 * here closes the practical, attacker-controlled bypass.
 */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await validateExternalUrl(currentUrl);
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response; // 3xx without a target — hand back as-is
      // Resolve relative redirects against the current URL, then loop to re-validate.
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }
  throw new Error('Too many redirects');
}
