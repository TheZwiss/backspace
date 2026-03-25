import * as cheerio from 'cheerio';
import { validateExternalUrl } from './ssrf.js';

export interface UrlMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
  /** Set when the URL itself is a direct media resource (image/video/audio) */
  contentType?: string;
  /** Extracted from og:image:width — only present for HTML pages with OG tags */
  imageWidth?: number;
  /** Extracted from og:image:height — only present for HTML pages with OG tags */
  imageHeight?: number;
}

export async function fetchUrlMetadata(url: string): Promise<UrlMetadata | null> {
  try {
    await validateExternalUrl(url);
  } catch {
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

    // If the response is a direct media file (image/video/audio), return early
    // with the content type — don't try to parse it as HTML
    const responseContentType = response.headers.get('content-type') ?? '';
    if (responseContentType.startsWith('image/') || responseContentType.startsWith('video/') || responseContentType.startsWith('audio/')) {
      return { title: null, description: null, image: null, siteName: null, url, contentType: responseContentType };
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

    const rawWidth = $('meta[property="og:image:width"]').attr('content');
    const rawHeight = $('meta[property="og:image:height"]').attr('content');
    const parsedWidth = rawWidth ? parseInt(rawWidth, 10) : NaN;
    const parsedHeight = rawHeight ? parseInt(rawHeight, 10) : NaN;

    const metadata: UrlMetadata = {
      title: $('meta[property="og:title"]').attr('content') || $('title').text() || null,
      description:
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') ||
        null,
      image: $('meta[property="og:image"]').attr('content') || null,
      siteName: $('meta[property="og:site_name"]').attr('content') || null,
      url,
      imageWidth: Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : undefined,
      imageHeight: Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : undefined,
    };

    return metadata;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
