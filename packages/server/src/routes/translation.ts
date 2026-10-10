import type { FastifyInstance } from 'fastify';
import { TranslationService, TranslationVault, TranslationError, record, connectionProbe } from '@backspace/translation';
import { getRawDb } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { config } from '../config.js';
import { loadTranslationEncryption } from '../translation/encryptionKey.js';
import { ServerTranslationStorage, SERVER_TRANSLATION_ORIGIN } from '../translation/storage.js';
import { serverProviderFetch, serverProviderUrl } from '../translation/providerFetch.js';

export async function translationRoutes(app: FastifyInstance): Promise<void> {
  const db = getRawDb();
  const encryption = loadTranslationEncryption({ db, dbPath: config.dbPath, keyHex: process.env.AI_TRANSLATION_ENCRYPTION_KEY });
  const storage = new ServerTranslationStorage(db, encryption);
  const service = new TranslationService(new TranslationVault(storage.vault), serverProviderFetch, storage.cache);
  app.post('/api/translation/command', {
    preHandler: authenticate,
    bodyLimit: 48 * 1024,
    config: { rateLimit: { max: 90, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.homeInstance) return reply.code(403).send({ ok: false, code: 'untrusted-sender' });
    try {
      const input = record(request.body);
      // A stale session may not write another account's settings; identity always comes from authentication.
      if (input.accountId !== request.userId) throw new TranslationError('untrusted-sender');
      if (['saveConnection', 'listModels', 'testConnection'].includes(String(input.action)))
        serverProviderUrl(connectionProbe(input.connection).baseUrl);
      return await service.command(SERVER_TRANSLATION_ORIGIN, { ...input, accountId: request.userId });
    } catch (error) {
      const code = error instanceof TranslationError ? error.code : 'invalid-input';
      return reply.code(400).send({ ok: false, code });
    }
  });
}
