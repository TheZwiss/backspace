import type {
  ComposerAction,
  ConnectionInput,
  ConnectionProbe,
  TranslationErrorCode,
  TranslationLanguage,
  TranslationPreferences,
} from '../../shared/src/translation';

export class TranslationError extends Error {
  constructor(
    public readonly code: TranslationErrorCode,
    public readonly status?: number,
  ) {
    super(code);
  }
}
export const TARGET_LANGUAGES: readonly TranslationLanguage[] = [
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
];
export const ANONYMOUS_ENGINES: readonly string[] = [];
export const SUPPORTED_PROTOCOLS = [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
  'google-translate',
  'microsoft-translator',
] as const;
export const MAX_TEXT_LENGTH = 15000;
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TranslationError('invalid-input');
  return value as Record<string, unknown>;
}
export function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new TranslationError('invalid-input');
  return value.trim();
}
export function accountId(value: unknown): string {
  const id = string(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new TranslationError('invalid-input');
  return id;
}
export function baseUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(string(value, 2048));
  } catch {
    throw new TranslationError('invalid-input');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new TranslationError('invalid-input');
  // A credential must never hide in URL userinfo, query parameters or fragments.
  if (url.username || url.password || url.search || url.hash) throw new TranslationError('invalid-input');
  return url.href.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages)$/, '').replace(/\/+$/, '');
}
export function connectionProbe(value: unknown): ConnectionProbe {
  const v = record(value);
  if (!SUPPORTED_PROTOCOLS.includes(String(v.protocol) as (typeof SUPPORTED_PROTOCOLS)[number]))
    throw new TranslationError('invalid-input');
  if (
    v.apiKey !== undefined &&
    (typeof v.apiKey !== 'string' || v.apiKey.length > 4096 || /[\r\n]/.test(v.apiKey))
  )
    throw new TranslationError('invalid-input');
  return {
    id: v.id === undefined ? undefined : string(v.id, 64),
    protocol: v.protocol as ConnectionInput['protocol'],
    baseUrl: baseUrl(v.baseUrl),
    model: v.model === undefined ? undefined : string(v.model, 160),
    apiKey: v.apiKey as string | undefined,
  };
}
export function connectionInput(value: unknown): ConnectionInput {
  const v = record(value);
  return { ...connectionProbe(value), name: string(v.name, 80), model: string(v.model, 160) };
}
export function composerActionInput(value: unknown): ComposerAction {
  const v = record(value);
  return {
    id: string(v.id, 64),
    label: string(v.label, 80),
    icon: v.icon === undefined || v.icon === null ? undefined : string(v.icon, 16),
    systemPrompt: string(v.systemPrompt, 4000),
    enabled: Boolean(v.enabled),
    isCustom: v.isCustom === undefined ? undefined : Boolean(v.isCustom),
  };
}
export function preferencesInput(value: unknown): TranslationPreferences {
  const v = record(value);
  if (!TARGET_LANGUAGES.includes(v.targetLanguage as TranslationLanguage))
    throw new TranslationError('invalid-input');
  for (const key of ['automatic', 'showOriginal', 'consent']) {
    if (typeof v[key] !== 'boolean') throw new TranslationError('invalid-input');
  }
  const rawEngine = v.engine === null ? null : string(v.engine, 64);
  const engine = rawEngine === 'google-free' || rawEngine === 'microsoft-free' ? null : rawEngine;
  let composerActions: ComposerAction[] | undefined;
  if (v.composerActions !== undefined) {
    if (!Array.isArray(v.composerActions) || v.composerActions.length > 50) {
      throw new TranslationError('invalid-input');
    }
    composerActions = v.composerActions.map(composerActionInput);
  }
  return {
    defaultConnection: v.defaultConnection === null ? null : string(v.defaultConnection, 64),
    engine,
    targetLanguage: v.targetLanguage as TranslationLanguage,
    automatic: v.automatic as boolean,
    showOriginal: v.showOriginal as boolean,
    consent: v.consent as boolean,
    translationEnabled: v.translationEnabled !== undefined ? Boolean(v.translationEnabled) : true,
    summarizerEnabled: Boolean(v.summarizerEnabled),
    summarizerConnection: v.summarizerConnection ? string(v.summarizerConnection, 64) : null,
    composerEnabled: Boolean(v.composerEnabled),
    composerConnection: v.composerConnection ? string(v.composerConnection, 64) : null,
    composerActions,
  };
}
