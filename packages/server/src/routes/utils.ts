import type { FastifyInstance } from 'fastify';
import dns from 'dns';
import { authenticate } from '../utils/auth.js';
import * as cheerio from 'cheerio';

function isPrivateIp(ip: string): boolean {
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

export async function utilRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { url: string } }>('/api/utils/metadata', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { url } = request.query;

    if (!url) {
      return reply.code(400).send({ error: 'URL is required' });
    }

    // Validate URL scheme
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({ error: 'Invalid URL' });
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reply.code(400).send({ error: 'Only HTTP(S) URLs are supported' });
    }

    // Resolve hostname and block private/internal IPs
    let address: string;
    try {
      const result = await dns.promises.lookup(parsed.hostname);
      address = result.address;
    } catch {
      return reply.code(200).send({});
    }

    if (isPrivateIp(address)) {
      return reply.code(400).send({ error: 'URLs pointing to private/internal addresses are not allowed' });
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
        return reply.code(200).send({});
      }

      // Reject oversized responses
      const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
      if (contentLength > 512_000) {
        return reply.code(200).send({});
      }

      const html = await response.text();
      const safeHtml = html.length > 512_000 ? html.slice(0, 512_000) : html;

      const $ = cheerio.load(safeHtml);

      const metadata = {
        title: $('meta[property="og:title"]').attr('content') || $('title').text(),
        description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content'),
        image: $('meta[property="og:image"]').attr('content'),
        siteName: $('meta[property="og:site_name"]').attr('content'),
        url: url,
      };

      return reply.code(200).send(metadata);
    } catch (err) {
      return reply.code(200).send({}); // Fail silently with empty object
    } finally {
      clearTimeout(timeout);
    }
  });
}
