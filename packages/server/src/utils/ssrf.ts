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
