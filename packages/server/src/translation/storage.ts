import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  isTranslationLanguage,
  isTranslationProtocol,
  MAX_PROVIDER_LABEL_LENGTH,
  MAX_PROVIDER_MODEL_LENGTH,
  MAX_TRANSLATION_RESULT_LENGTH,
  TRANSLATION_CACHE_LIMIT,
  TRANSLATION_CACHE_MAX_BYTES,
  type AdminTranslationProviderInput,
  type AdminTranslationProviderView,
  type TranslationLanguage,
  type TranslationProtocol,
  type UpdateTranslationPreferencesRequest,
  type UserTranslationStatusResponse,
} from '@backspace/shared/src/translation.js';
import type { ProviderConnection } from './aiProtocols.js';
import type { TranslationEncryption } from './encryption.js';
import { TranslationFault } from './errors.js';
import { TRANSLATION_PROMPT_VERSION } from './prompt.js';
import { validatePublicProviderBaseUrl } from './providerFetch.js';
import { TEXT_POLICY_VERSION } from './textPolicy.js';

interface ProviderRow {
  id: number;
  enabled: number;
  provider_label: string;
  protocol: string;
  base_url: string;
  model: string;
  encrypted_api_key: Buffer;
  updated_at: number;
}

interface PreferenceRow {
  user_id: string;
  consented_provider_fingerprint: string | null;
  consented_at: number | null;
  target_language: string;
  show_original: number;
  updated_at: number;
}

export interface ActiveProviderRuntime {
  connection: ProviderConnection;
  label: string;
  host: string;
  fingerprint: string;
}

export class ServerTranslationStorage {
  constructor(
    private readonly db: Database.Database,
    private readonly encryption: TranslationEncryption,
  ) {}

  getInstanceId(): string {
    const row = this.db.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as
      | { instance_id: string | null }
      | undefined;
    return row?.instance_id || 'default-instance';
  }

  computeProviderFingerprint(protocol: TranslationProtocol, host: string): string {
    return createHash('sha256')
      .update(JSON.stringify([this.getInstanceId(), protocol, host.toLowerCase()]))
      .digest('hex');
  }

  requireActiveAccount(userId: string): void {
    const row = this.db.prepare(
      'SELECT 1 FROM users WHERE id = ? AND COALESCE(is_deleted, 0) = 0',
    ).get(userId);
    if (!row) {
      throw new TranslationFault('invalid_input');
    }
  }

  private readProviderRow(): ProviderRow | undefined {
    return this.db.prepare('SELECT * FROM ai_translation_provider WHERE id = 1').get() as
      | ProviderRow
      | undefined;
  }

  private decryptProviderKey(encrypted: Buffer): string {
    try {
      return this.encryption.decrypt(encrypted, `provider:${this.getInstanceId()}:1`);
    } catch {
      throw new TranslationFault('storage_error');
    }
  }

  getAdminProviderView(): AdminTranslationProviderView {
    const row = this.readProviderRow();
    if (!row || !isTranslationProtocol(row.protocol)) {
      return {
        configured: false,
        enabled: false,
        providerLabel: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        providerHost: null,
        model: '',
        hasApiKey: false,
        updatedAt: null,
      };
    }
    const { host } = validatePublicProviderBaseUrl(row.base_url);
    return {
      configured: true,
      enabled: row.enabled === 1,
      providerLabel: row.provider_label,
      protocol: row.protocol,
      baseUrl: row.base_url,
      providerHost: host,
      model: row.model,
      hasApiKey: row.encrypted_api_key.length > 0,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Resolves API key for admin model discovery / connection probe without saving.
   * Reuses the stored key ONLY when protocol and normalized baseUrl are unchanged,
   * preventing an existing key from ever being sent to a newly typed host.
   */
  resolveProbeApiKey(protocol: TranslationProtocol, normalizedBaseUrl: string, submittedKey?: string): string {
    const trimmed = submittedKey?.trim();
    if (trimmed) return trimmed;

    const existing = this.readProviderRow();
    if (!existing || existing.protocol !== protocol || existing.base_url !== normalizedBaseUrl) {
      throw new TranslationFault('invalid_input');
    }
    return this.decryptProviderKey(existing.encrypted_api_key);
  }

  saveAdminProvider(input: AdminTranslationProviderInput): AdminTranslationProviderView {
    if (typeof input.enabled !== 'boolean' || !isTranslationProtocol(input.protocol)) {
      throw new TranslationFault('invalid_input');
    }
    const label = input.providerLabel.trim();
    const model = input.model.trim();
    if (
      !label ||
      label.length > MAX_PROVIDER_LABEL_LENGTH ||
      !model ||
      model.length > MAX_PROVIDER_MODEL_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(label) ||
      /[\u0000-\u001f\u007f]/.test(model)
    ) {
      throw new TranslationFault('invalid_input');
    }

    const { normalizedBaseUrl } = validatePublicProviderBaseUrl(input.baseUrl);
    const existing = this.readProviderRow();
    const submittedKey = input.apiKey?.trim() || '';

    let apiKeyToStore: string;
    if (submittedKey) {
      if (submittedKey.length > 512 || /[\r\n\u0000]/.test(submittedKey)) {
        throw new TranslationFault('invalid_input');
      }
      apiKeyToStore = submittedKey;
    } else if (existing && existing.protocol === input.protocol && existing.base_url === normalizedBaseUrl) {
      apiKeyToStore = this.decryptProviderKey(existing.encrypted_api_key);
    } else {
      throw new TranslationFault('invalid_input');
    }

    const instanceId = this.getInstanceId();
    const encryptedKey = this.encryption.encrypt(apiKeyToStore, `provider:${instanceId}:1`);
    const now = Date.now();
    const providerChanged =
      !existing ||
      existing.protocol !== input.protocol ||
      existing.base_url !== normalizedBaseUrl ||
      existing.model !== model ||
      !input.enabled;

    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO ai_translation_provider
          (id, enabled, provider_label, protocol, base_url, model, encrypted_api_key, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           provider_label = excluded.provider_label,
           protocol = excluded.protocol,
           base_url = excluded.base_url,
           model = excluded.model,
           encrypted_api_key = excluded.encrypted_api_key,
           updated_at = excluded.updated_at`,
      ).run(input.enabled ? 1 : 0, label, input.protocol, normalizedBaseUrl, model, encryptedKey, now);

      if (providerChanged) {
        this.db.prepare('DELETE FROM ai_translation_cache').run();
      }
    })();

    return this.getAdminProviderView();
  }

  deleteAdminProvider(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM ai_translation_provider WHERE id = 1').run();
      this.db.prepare('DELETE FROM ai_translation_cache').run();
      this.db.prepare(
        'UPDATE ai_translation_preferences SET consented_provider_fingerprint = NULL, consented_at = NULL',
      ).run();
    })();
  }

  clearInstanceCache(): number {
    return this.db.prepare('DELETE FROM ai_translation_cache').run().changes;
  }

  getActiveProvider(): ActiveProviderRuntime | null {
    const row = this.readProviderRow();
    if (!row || row.enabled !== 1 || !isTranslationProtocol(row.protocol)) {
      return null;
    }
    const { normalizedBaseUrl, host } = validatePublicProviderBaseUrl(row.base_url);
    const apiKey = this.decryptProviderKey(row.encrypted_api_key);
    return {
      connection: {
        protocol: row.protocol,
        baseUrl: normalizedBaseUrl,
        model: row.model,
        apiKey,
      },
      label: row.provider_label,
      host,
      fingerprint: this.computeProviderFingerprint(row.protocol, host),
    };
  }

  getUserStatus(userId: string): UserTranslationStatusResponse {
    this.requireActiveAccount(userId);
    const active = this.getActiveProvider();
    const pref = this.db.prepare(
      'SELECT * FROM ai_translation_preferences WHERE user_id = ?',
    ).get(userId) as PreferenceRow | undefined;

    const targetLanguage: TranslationLanguage =
      pref && isTranslationLanguage(pref.target_language) ? pref.target_language : 'en';
    const showOriginal = pref ? pref.show_original === 1 : true;
    const consented = Boolean(
      active && pref?.consented_provider_fingerprint === active.fingerprint,
    );

    return {
      enabled: active !== null,
      provider: active
        ? {
            label: active.label,
            host: active.host,
            fingerprint: active.fingerprint,
          }
        : null,
      preferences: {
        consented,
        consentedAt: consented ? (pref?.consented_at ?? null) : null,
        targetLanguage,
        showOriginal,
      },
    };
  }

  updateUserPreferences(
    userId: string,
    input: UpdateTranslationPreferencesRequest,
  ): UserTranslationStatusResponse {
    this.requireActiveAccount(userId);
    const current = this.db.prepare(
      'SELECT * FROM ai_translation_preferences WHERE user_id = ?',
    ).get(userId) as PreferenceRow | undefined;

    let targetLanguage: TranslationLanguage =
      current && isTranslationLanguage(current.target_language) ? current.target_language : 'en';
    if (input.targetLanguage !== undefined) {
      if (!isTranslationLanguage(input.targetLanguage)) {
        throw new TranslationFault('invalid_input');
      }
      targetLanguage = input.targetLanguage;
    }

    let showOriginal = current ? current.show_original === 1 : true;
    if (input.showOriginal !== undefined) {
      if (typeof input.showOriginal !== 'boolean') {
        throw new TranslationFault('invalid_input');
      }
      showOriginal = input.showOriginal;
    }

    let consentedFingerprint = current?.consented_provider_fingerprint ?? null;
    let consentedAt = current?.consented_at ?? null;
    let purgeUserCache = false;

    if (input.consent !== undefined) {
      if (typeof input.consent !== 'boolean') {
        throw new TranslationFault('invalid_input');
      }
      if (input.consent) {
        const active = this.getActiveProvider();
        if (!active || input.providerFingerprint !== active.fingerprint) {
          throw new TranslationFault('invalid_input');
        }
        consentedFingerprint = active.fingerprint;
        consentedAt = Date.now();
      } else {
        consentedFingerprint = null;
        consentedAt = null;
        purgeUserCache = true;
      }
    }

    const now = Date.now();
    this.db.transaction(() => {
      this.requireActiveAccount(userId);
      this.db.prepare(
        `INSERT INTO ai_translation_preferences
          (user_id, consented_provider_fingerprint, consented_at, target_language, show_original, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           consented_provider_fingerprint = excluded.consented_provider_fingerprint,
           consented_at = excluded.consented_at,
           target_language = excluded.target_language,
           show_original = excluded.show_original,
           updated_at = excluded.updated_at`,
      ).run(userId, consentedFingerprint, consentedAt, targetLanguage, showOriginal ? 1 : 0, now);

      if (purgeUserCache) {
        this.db.prepare('DELETE FROM ai_translation_cache WHERE user_id = ?').run(userId);
      }
    })();

    return this.getUserStatus(userId);
  }

  clearUserCache(userId: string): number {
    this.requireActiveAccount(userId);
    return this.db.prepare('DELETE FROM ai_translation_cache WHERE user_id = ?').run(userId).changes;
  }

  computeResultKey(input: {
    userId: string;
    connection: ProviderConnection;
    targetLanguage: TranslationLanguage;
    sourceText: string;
  }): string {
    const instanceId = this.getInstanceId();
    return createHash('sha256')
      .update(
        JSON.stringify([
          TEXT_POLICY_VERSION,
          TRANSLATION_PROMPT_VERSION,
          instanceId,
          input.userId,
          input.connection.protocol,
          input.connection.baseUrl,
          input.connection.model,
          input.targetLanguage,
          input.sourceText,
        ]),
      )
      .digest('hex');
  }

  getCachedTranslation(userId: string, resultKey: string): string | null {
    this.requireActiveAccount(userId);
    const instanceId = this.getInstanceId();
    const row = this.db.prepare(
      'SELECT instance_id, encrypted FROM ai_translation_cache WHERE user_id = ? AND result_key = ?',
    ).get(userId, resultKey) as { instance_id: string; encrypted: Buffer } | undefined;

    if (!row) return null;
    if (row.instance_id !== instanceId) {
      this.db.prepare('DELETE FROM ai_translation_cache WHERE user_id = ? AND result_key = ?').run(userId, resultKey);
      return null;
    }

    try {
      const text = this.encryption.decrypt(row.encrypted, `cache:${instanceId}:${userId}:${resultKey}`);
      if (!text.trim() || text.length > MAX_TRANSLATION_RESULT_LENGTH) {
        throw new Error('Corrupt cached translation');
      }
      this.db.prepare(
        'UPDATE ai_translation_cache SET used_at = ? WHERE user_id = ? AND result_key = ?',
      ).run(Date.now(), userId, resultKey);
      return text;
    } catch {
      throw new TranslationFault('storage_error');
    }
  }

  setCachedTranslation(
    userId: string,
    expectedProviderFingerprint: string,
    resultKey: string,
    translatedText: string,
  ): void {
    const instanceId = this.getInstanceId();
    let encrypted: Buffer;
    try {
      encrypted = this.encryption.encrypt(translatedText, `cache:${instanceId}:${userId}:${resultKey}`);
    } catch {
      throw new TranslationFault('storage_error');
    }

    this.db.transaction(() => {
      // Re-verify account existence and consent inside the write transaction so
      // an account deleted or consent revoked mid-flight cannot resurrect cache data.
      this.requireActiveAccount(userId);
      const pref = this.db.prepare(
        'SELECT consented_provider_fingerprint FROM ai_translation_preferences WHERE user_id = ?',
      ).get(userId) as { consented_provider_fingerprint: string | null } | undefined;
      if (pref?.consented_provider_fingerprint !== expectedProviderFingerprint) {
        return;
      }

      this.db.prepare(
        `INSERT INTO ai_translation_cache (instance_id, user_id, result_key, encrypted, used_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, result_key) DO UPDATE SET
           instance_id = excluded.instance_id,
           encrypted = excluded.encrypted,
           used_at = excluded.used_at`,
      ).run(instanceId, userId, resultKey, encrypted, Date.now());

      this.pruneUserCache(userId);
    })();
  }

  private pruneUserCache(userId: string): void {
    const rows = this.db.prepare(
      'SELECT result_key, length(encrypted) AS bytes FROM ai_translation_cache WHERE user_id = ? ORDER BY used_at DESC, rowid DESC',
    ).all(userId) as Array<{ result_key: string; bytes: number }>;

    let totalBytes = 0;
    rows.forEach((row, index) => {
      totalBytes += row.bytes;
      if (index >= TRANSLATION_CACHE_LIMIT || totalBytes > TRANSLATION_CACHE_MAX_BYTES) {
        this.db.prepare('DELETE FROM ai_translation_cache WHERE user_id = ? AND result_key = ?')
          .run(userId, row.result_key);
      }
    });
  }
}
