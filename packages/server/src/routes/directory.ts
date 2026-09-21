import type { FastifyInstance } from 'fastify';
import type { DirectoryDocument } from '@backspace/shared';
import { getRawDb } from '../db/index.js';
import { config } from '../config.js';
import { buildDirectoryDocument } from '../directory/document.js';
import { getDocumentVersion } from '../directory/state.js';
import { resolveLocalOrigin } from './federation/origin.js';

/**
 * How long a built document is served before it is rebuilt, whether or not
 * anything changed. The hub fetches from many Cloudflare addresses, so the
 * per-user-or-IP rate limiter is no guard against a distributed reader; this
 * cache is. A change (markDirectoryDirty) drops it sooner, so the document
 * served is never older than the last change.
 */
const DOCUMENT_CACHE_MS = 30_000;

interface DocumentCache {
  version: number;
  at: number;
  doc: DirectoryDocument;
}

let cache: DocumentCache | null = null;

function getDocument(): DirectoryDocument {
  const version = getDocumentVersion();
  const now = Date.now();
  if (cache !== null && cache.version === version && now - cache.at < DOCUMENT_CACHE_MS) {
    return cache.doc;
  }
  const doc = buildDirectoryDocument(getRawDb(), { origin: resolveLocalOrigin(), version: config.version });
  cache = { version, at: now, doc };
  return doc;
}

export function _resetDirectoryRouteCacheForTests(): void {
  cache = null;
}

export async function directoryRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/directory/spaces: the public document the hub indexes. No auth
  // on purpose; the hub is a stranger. It never 404s (a switched-off
  // instance serves an empty list), so a fetch of one is a success that
  // clears its rows at the hub.
  app.get('/api/directory/spaces', async (_request, reply) => {
    const doc = getDocument();
    return reply
      .code(200)
      .header('cache-control', `public, max-age=${DOCUMENT_CACHE_MS / 1000}`)
      .send(doc);
  });
}
