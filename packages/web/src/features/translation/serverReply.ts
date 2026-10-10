import type { AiConnection, TranslationPreferences, TranslationReply, TranslationResult, TranslationSettings } from '@backspace/shared/translation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function isConnection(value: unknown): value is AiConnection {
  if (!isRecord(value) || 'apiKey' in value) return false;
  return ['id', 'name', 'baseUrl', 'model'].every(key => typeof value[key] === 'string') &&
    ['openai-chat', 'openai-responses', 'anthropic', 'gemini'].includes(String(value.protocol)) &&
    typeof value.hasKey === 'boolean';
}
function isPreferences(value: unknown): value is TranslationPreferences {
  if (!isRecord(value)) return false;
  return ['defaultConnection', 'engine'].every(key => value[key] === null || typeof value[key] === 'string') &&
    ['automatic', 'showOriginal', 'consent'].every(key => typeof value[key] === 'boolean') &&
    ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru', 'ar'].includes(String(value.targetLanguage));
}
function isSettings(value: unknown): value is TranslationSettings {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 &&
    Array.isArray(value.connections) && value.connections.every(isConnection) && isPreferences(value.preferences);
}
function isResult(value: unknown): value is TranslationResult {
  if (!isRecord(value)) return false;
  if (value.kind === 'translated') return typeof value.text === 'string' && !!value.text.trim();
  return value.kind === 'skipped' && ['same-language', 'not-text', 'uncertain-language'].includes(String(value.reason));
}
function isModels(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1000 &&
    value.every(id => typeof id === 'string' && !!id.trim() && id.length <= 160 && !/[\u0000-\u001f\u007f]/.test(id));
}
function isConnectionTest(value: unknown): value is { text: string; latencyMs: number } {
  if (!isRecord(value)) return false;
  return typeof value.text === 'string' && !!value.text.trim() && value.text.length <= 2000 &&
    Number.isSafeInteger(value.latencyMs) && Number(value.latencyMs) >= 0;
}
function readSuccess(value: Record<string, unknown>): TranslationReply {
  if (isSettings(value.settings)) return { ok: true, settings: value.settings };
  if (isResult(value.result)) return { ok: true, result: value.result };
  if (isModels(value.models)) return { ok: true, models: value.models };
  if (isConnectionTest(value.test)) return { ok: true, test: { text: value.test.text, latencyMs: value.test.latencyMs } };
  return { ok: false, code: 'invalid-response' };
}
const ERROR_CODES = new Set([
  'server-not-configured', 'unsafe-endpoint', 'insecure-transport', 'invalid-input', 'untrusted-sender',
  'secure-storage', 'storage', 'cache-storage', 'missing-connection', 'consent-required', 'stale-settings',
  'busy', 'network', 'timeout', 'http', 'invalid-response', 'protected-content', 'anonymous-unavailable',
]);
/** Old servers and reverse proxies can return HTML or unrelated JSON; never accept it as success. */
export function readServerReply(value: unknown): TranslationReply {
  if (!isRecord(value)) return { ok: false, code: 'invalid-response' };
  if (value.ok === true) return readSuccess(value);
  if (value.ok === false && typeof value.code === 'string' && ERROR_CODES.has(value.code)) {
    const status = Number.isInteger(value.status) ? Number(value.status) : undefined;
    return { ok: false, code: value.code as Extract<TranslationReply, { ok: false }>['code'], status };
  }
  return { ok: false, code: 'invalid-response' };
}
