import dns from 'dns';
import * as cheerio from 'cheerio';

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

export interface UrlMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
}

export async function fetchUrlMetadata(url: string): Promise<UrlMetadata | null> {
  // Validate URL scheme
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return null;
  }

  // Resolve hostname and block private/internal IPs
  let address: string;
  try {
    const result = await dns.promises.lookup(parsed.hostname);
    address = result.address;
  } catch {
    return null;
  }

  if (isPrivateIp(address)) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'BackspaceBot/1.0',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    // Early exit if Content-Length > 512KB
    const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
    if (contentLength > 512_000) {
      return null;
    }

    // Stream-read the body with a hard 512KB byte limit to prevent OOM from chunked responses
    if (!response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.length;
      if (bytesRead > 512_000) {
        reader.cancel();
        break;
      }
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode(); // flush remaining

    const $ = cheerio.load(html);

    const metadata: UrlMetadata = {
      title: $('meta[property="og:title"]').attr('content') ?? $('title').text() ?? null,
      description:
        $('meta[property="og:description"]').attr('content') ??
        $('meta[name="description"]').attr('content') ??
        null,
      image: $('meta[property="og:image"]').attr('content') ?? null,
      siteName: $('meta[property="og:site_name"]').attr('content') ?? null,
      url,
    };

    return metadata;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
