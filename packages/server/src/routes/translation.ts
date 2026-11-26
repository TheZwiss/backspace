import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { stickerUrl } from '@backspace/shared/src/stickers.js';
import {
  isTranslationLanguage,
  isTranslationProtocol,
  MAX_PROVIDER_MODEL_LENGTH,
  MAX_TRANSLATION_SOURCE_LENGTH,
  type AdminTranslationProbeInput,
  type AdminTranslationProviderInput,
  type TranslateMessageRequest,
  type TranslateMessageResponse,
  type UpdateTranslationPreferencesRequest,
} from '@backspace/shared/src/translation.js';
import { config } from '../config.js';
import { getDb, getRawDb, schema } from '../db/index.js';
import { userWrittenMessages } from '../db/userWrittenMessages.js';
import { authenticate, requireAdmin } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { getChannelSpaceId, hasPermission, PermissionBits } from '../utils/permissions.js';
import { translateWithProvider } from '../translation/aiProtocols.js';
import { listProviderModels, testProviderConnection } from '../translation/connectionDiagnostics.js';
import { loadTranslationEncryption } from '../translation/encryptionKey.js';
import { asRecord, TranslationFault } from '../translation/errors.js';
import { serverProviderFetch, validatePublicProviderBaseUrl, type ProviderFetch } from '../translation/providerFetch.js';
import { ServerTranslationStorage } from '../translation/storage.js';
import { hasTranslatableText, protectText, restoreProtectedText } from '../translation/textPolicy.js';

export interface TranslationRouteOptions {
  providerFetch?: ProviderFetch;
  encryptionKeyHex?: string;
}

function sendTranslationFault(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TranslationFault) {
    switch (error.code) {
      case 'unsafe_endpoint':
        return sendError(reply, 400, 'translation_unsafe_endpoint');
      case 'text_too_long':
        return sendError(reply, 400, 'translation_text_too_long', { max: MAX_TRANSLATION_SOURCE_LENGTH });
      case 'protected_content':
        return sendError(reply, 502, 'translation_protected_content');
      case 'provider_failed':
        return sendError(reply, 502, 'translation_provider_failed');
      case 'storage_error':
        return sendError(reply, 500, 'translation_storage_error');
      case 'invalid_input':
      default:
        return sendError(reply, 400, 'translation_provider_invalid');
    }
  }
  return sendError(reply, 500, 'translation_storage_error');
}

function resolveAuthorizedMessageText(
  userId: string,
  input: { channelId?: string; dmChannelId?: string; messageId: string },
): { status: 'ok'; content: string } | { status: 'forbidden' } | { status: 'not_found' } {
  const db = getDb();
  const hasChannel = Boolean(input.channelId);
  const hasDm = Boolean(input.dmChannelId);
  if (hasChannel === hasDm || !input.messageId.trim()) {
    return { status: 'not_found' };
  }

  if (input.channelId) {
    const spaceId = getChannelSpaceId(input.channelId);
    if (!spaceId) return { status: 'not_found' };
    const canView =
      hasPermission(userId, spaceId, PermissionBits.VIEW_CHANNEL, input.channelId) &&
      hasPermission(userId, spaceId, PermissionBits.READ_MESSAGE_HISTORY, input.channelId);
    if (!canView) return { status: 'forbidden' };

    const msg = db.select({ content: schema.messages.content })
      .from(schema.messages)
      .where(and(
        eq(schema.messages.id, input.messageId),
        eq(schema.messages.channelId, input.channelId),
        userWrittenMessages(),
      ))
      .get();
    if (!msg) return { status: 'not_found' };
    return { status: 'ok', content: msg.content ?? '' };
  }

  const dmChannelId = input.dmChannelId!;
  const member = db.select({ userId: schema.dmMembers.userId })
    .from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, dmChannelId),
      eq(schema.dmMembers.userId, userId),
    ))
    .get();
  if (!member) return { status: 'forbidden' };

  const dmMsg = db.select({ content: schema.dmMessages.content, type: schema.dmMessages.type })
    .from(schema.dmMessages)
    .where(and(
      eq(schema.dmMessages.id, input.messageId),
      eq(schema.dmMessages.dmChannelId, dmChannelId),
    ))
    .get();
  if (!dmMsg || (dmMsg.type !== null && dmMsg.type !== 'user')) return { status: 'not_found' };
  return { status: 'ok', content: dmMsg.content ?? '' };
}

export async function translationRoutes(
  app: FastifyInstance,
  opts: TranslationRouteOptions = {},
): Promise<void> {
  const rawDb = getRawDb();
  const encryption = loadTranslationEncryption({
    db: rawDb,
    dbPath: config.dbPath,
    keyHex: opts.encryptionKeyHex ?? process.env.AI_TRANSLATION_ENCRYPTION_KEY,
  });
  const storage = new ServerTranslationStorage(rawDb, encryption);
  const fetcher = opts.providerFetch ?? serverProviderFetch;

  // ─── Admin: Single Instance Provider Configuration ─────────────────────────

  app.get('/api/admin/translation', {
    preHandler: [authenticate, requireAdmin],
  }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return storage.getAdminProviderView();
    } catch (error) {
      return sendTranslationFault(reply, error);
    }
  });

  app.put<{ Body: AdminTranslationProviderInput }>('/api/admin/translation', {
    preHandler: [authenticate, requireAdmin],
    bodyLimit: 16 * 1024,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const body = asRecord(request.body) as unknown as AdminTranslationProviderInput;
      return storage.saveAdminProvider(body);
    } catch (error) {
      return sendTranslationFault(reply, error);
    }
  });

  app.delete('/api/admin/translation', {
    preHandler: [authenticate, requireAdmin],
  }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      storage.deleteAdminProvider();
      return { success: true };
    } catch (error) {
      return sendTranslationFault(reply, error);
    }
  });

  app.delete('/api/admin/translation/cache', {
    preHandler: [authenticate, requireAdmin],
  }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return { cleared: storage.clearInstanceCache() };
    } catch (error) {
      return sendTranslationFault(reply, error);
    }
  });

  app.post<{ Body: AdminTranslationProbeInput }>('/api/admin/translation/models', {
    preHandler: [authenticate, requireAdmin],
    bodyLimit: 16 * 1024,
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => req.ip,
      },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const body = asRecord(request.body);
      if (!isTranslationProtocol(body.protocol) || typeof body.baseUrl !== 'string') {
        throw new TranslationFault('invalid_input');
      }
      const { normalizedBaseUrl } = validatePublicProviderBaseUrl(body.baseUrl);
      const apiKey = storage.resolveProbeApiKey(
        body.protocol,
        normalizedBaseUrl,
        typeof body.apiKey === 'string' ? body.apiKey : undefined,
      );
      const models = await listProviderModels({
        protocol: body.protocol,
        baseUrl: normalizedBaseUrl,
        apiKey,
        fetcher,
      });
      return { models };
    } catch (error) {
      return sendTranslationFault(reply, error);
    }
  });

  app.post<{ Body: AdminTranslationProbeInput }>('/api/admin/translation/test', {
    preHandler: [authenticate, requireAdmin],
    bodyLimit: 16 * 1024,
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => req.ip,
      },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const body = asRecord(request.body);
      if (
        !isTranslationProtocol(body.protocol) ||
        typeof body.baseUrl !== 'string' ||
        typeof body.model !== 'string'
      ) {
        throw new TranslationFault('invalid_input');
      }
      const model = body.model.trim();
      if (!model || model.length > MAX_PROVIDER_MODEL_LENGTH) {
        throw new TranslationFault('invalid_input');
      }
      const { normalizedBaseUrl } = validatePublicProviderBaseUrl(body.baseUrl);
      const apiKey = storage.resolveProbeApiKey(
        body.protocol,
        normalizedBaseUrl,
        typeof body.apiKey === 'string' ? body.apiKey : undefined,
      );
      const result = await testProviderConnection({
        connection: {
          protocol: body.protocol,
          baseUrl: normalizedBaseUrl,
          model,
          apiKey,
        },
        fetcher,
      });
      return result;
    } catch (error) {
      return sendTranslationFault(reply, error);
    }
  });

  // ─── User: Status, Explicit Consent, Cache Clear, and Single-Message Translate ─

  app.get('/api/translation/status', {
    preHandler: authenticate,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return storage.getUserStatus(request.userId);
    } catch (error) {
      return sendTranslationFault(reply, error);
    }
  });

  app.put<{ Body: UpdateTranslationPreferencesRequest }>('/api/translation/preferences', {
    preHandler: authenticate,
    bodyLimit: 8 * 1024,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const body = asRecord(request.body) as UpdateTranslationPreferencesRequest;
      return storage.updateUserPreferences(request.userId, body);
    } catch (error) {
      return sendTranslationFault(reply, error);
    }
  });

  app.delete('/api/translation/cache', {
    preHandler: authenticate,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return { cleared: storage.clearUserCache(request.userId) };
    } catch (error) {
      return sendTranslationFault(reply, error);
    }
  });

  app.post<{ Body: TranslateMessageRequest }>('/api/translation/translate', {
    preHandler: authenticate,
    bodyLimit: 8 * 1024,
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => req.ip,
      },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const body = asRecord(request.body);
      const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
      const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : undefined;
      const dmChannelId = typeof body.dmChannelId === 'string' ? body.dmChannelId.trim() : undefined;
      const providerFingerprint = typeof body.providerFingerprint === 'string' ? body.providerFingerprint.trim() : '';
      if (!messageId || !providerFingerprint) {
        return sendError(reply, 400, 'validation_failed');
      }

      const active = storage.getActiveProvider();
      if (!active) {
        return sendError(reply, 404, 'translation_disabled');
      }

      const status = storage.getUserStatus(request.userId);
      if (!status.preferences.consented || providerFingerprint !== active.fingerprint) {
        return sendError(reply, 403, 'translation_consent_required');
      }

      const targetLanguage =
        body.targetLanguage !== undefined
          ? (isTranslationLanguage(body.targetLanguage) ? body.targetLanguage : null)
          : status.preferences.targetLanguage;
      if (!targetLanguage) {
        return sendError(reply, 400, 'validation_failed');
      }

      const lookupResult = resolveAuthorizedMessageText(request.userId, {
        channelId,
        dmChannelId,
        messageId,
      });
      if (lookupResult.status === 'forbidden') {
        return sendError(reply, 403, 'forbidden');
      }
      if (lookupResult.status === 'not_found') {
        return sendError(reply, 404, 'message_not_found');
      }

      const sourceText = lookupResult.content;
      if (!sourceText || stickerUrl(sourceText) || !hasTranslatableText(sourceText)) {
        const skipped: TranslateMessageResponse = { kind: 'skipped', reason: 'not-text' };
        return skipped;
      }

      const resultKey = storage.computeResultKey({
        userId: request.userId,
        connection: active.connection,
        targetLanguage,
        sourceText,
      });

      const cached = storage.getCachedTranslation(request.userId, resultKey);
      if (cached !== null) {
        const hit: TranslateMessageResponse = {
          kind: 'translated',
          text: cached,
          targetLanguage,
          cached: true,
        };
        return hit;
      }

      const prepared = protectText(sourceText);
      const maskedTranslation = await translateWithProvider({
        connection: active.connection,
        maskedText: prepared.text,
        targetLanguage,
        fetcher,
      });
      const restored = restoreProtectedText(maskedTranslation, prepared);

      storage.setCachedTranslation(request.userId, active.fingerprint, resultKey, restored);

      const response: TranslateMessageResponse = {
        kind: 'translated',
        text: restored,
        targetLanguage,
        cached: false,
      };
      return response;
    } catch (error) {
      return sendTranslationFault(reply, error);
    }
  });
}
