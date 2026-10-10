import type {
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
export const ANONYMOUS_ENGINES = ['google-free', 'microsoft-free'];
export const MAX_TEXT_LENGTH = 6000;
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
  return url.href.replace(/\/+$/, '');
}
export function connectionProbe(value: unknown): ConnectionProbe {
  const v = record(value);
  if (!['openai-chat', 'openai-responses', 'anthropic', 'gemini'].includes(String(v.protocol)))
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
export function preferencesInput(value: unknown): TranslationPreferences {
  const v = record(value);
  if (!TARGET_LANGUAGES.includes(v.targetLanguage as TranslationLanguage))
    throw new TranslationError('invalid-input');
  for (const key of ['automatic', 'showOriginal', 'consent']) {
    if (typeof v[key] !== 'boolean') throw new TranslationError('invalid-input');
  }
  return {
    defaultConnection: v.defaultConnection === null ? null : string(v.defaultConnection, 64),
    engine: v.engine === null ? null : string(v.engine, 64),
    targetLanguage: v.targetLanguage as TranslationLanguage,
    automatic: v.automatic as boolean,
    showOriginal: v.showOriginal as boolean,
    consent: v.consent as boolean,
  };
}
