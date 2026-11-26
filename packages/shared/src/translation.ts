export const TRANSLATION_PROTOCOLS = [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
] as const;

export type TranslationProtocol = (typeof TRANSLATION_PROTOCOLS)[number];

export const TRANSLATION_LANGUAGES = [
  'zh-CN',
  'zh-TW',
  'en',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'pt',
  'ru',
  'ar',
] as const;

export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number];

export const MAX_TRANSLATION_SOURCE_LENGTH = 6000;
export const MAX_TRANSLATION_RESULT_LENGTH = 24000;
export const MAX_PROVIDER_LABEL_LENGTH = 80;
export const MAX_PROVIDER_MODEL_LENGTH = 160;
export const TRANSLATION_CACHE_LIMIT = 500;
export const TRANSLATION_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export function isTranslationProtocol(value: unknown): value is TranslationProtocol {
  return typeof value === 'string' && (TRANSLATION_PROTOCOLS as readonly string[]).includes(value);
}

export function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === 'string' && (TRANSLATION_LANGUAGES as readonly string[]).includes(value);
}

export interface AdminTranslationProviderView {
  configured: boolean;
  enabled: boolean;
  providerLabel: string;
  protocol: TranslationProtocol;
  baseUrl: string;
  providerHost: string | null;
  model: string;
  hasApiKey: boolean;
  updatedAt: number | null;
}

export interface AdminTranslationProviderInput {
  enabled: boolean;
  providerLabel: string;
  protocol: TranslationProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface AdminTranslationProbeInput {
  protocol: TranslationProtocol;
  baseUrl: string;
  model?: string;
  apiKey?: string;
}

export interface UserTranslationProviderSummary {
  label: string;
  host: string;
  fingerprint: string;
}

export interface UserTranslationPreferences {
  consented: boolean;
  consentedAt: number | null;
  targetLanguage: TranslationLanguage;
  showOriginal: boolean;
}

export interface UserTranslationStatusResponse {
  enabled: boolean;
  provider: UserTranslationProviderSummary | null;
  preferences: UserTranslationPreferences;
}

export interface UpdateTranslationPreferencesRequest {
  consent?: boolean;
  providerFingerprint?: string;
  targetLanguage?: TranslationLanguage;
  showOriginal?: boolean;
}

export interface TranslateMessageRequest {
  channelId?: string;
  dmChannelId?: string;
  messageId: string;
  targetLanguage?: TranslationLanguage;
  providerFingerprint: string;
}

export type TranslateMessageResponse =
  | {
      kind: 'translated';
      text: string;
      targetLanguage: TranslationLanguage;
      cached: boolean;
    }
  | {
      kind: 'skipped';
      reason: 'not-text';
    };
