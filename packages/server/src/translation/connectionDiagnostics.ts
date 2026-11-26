import { MAX_PROVIDER_MODEL_LENGTH, type TranslationProtocol } from '@backspace/shared/src/translation.js';
import { buildProviderHeaders, translateWithProvider, type ProviderConnection } from './aiProtocols.js';
import { asRecord, TranslationFault } from './errors.js';
import { requestProviderText, type ProviderFetch } from './providerFetch.js';

const MAX_MODEL_PAGES = 20;
const MAX_MODELS = 1000;

function readBoundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw new TranslationFault('provider_failed');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new TranslationFault('provider_failed');
  return trimmed;
}

function parseModelPage(protocol: TranslationProtocol, raw: unknown): { models: string[]; cursor?: string } {
  const value = asRecord(raw);
  const isGemini = protocol === 'gemini';
  const rows = isGemini ? value.models : value.data;
  if (!Array.isArray(rows)) throw new TranslationFault('provider_failed');

  const models = rows
    .map(asRecord)
    .filter(
      (row) =>
        !isGemini ||
        (Array.isArray(row.supportedGenerationMethods) &&
          row.supportedGenerationMethods.includes('generateContent')),
    )
    .map((row) => {
      const rawId = readBoundedString(isGemini ? row.name : row.id, MAX_PROVIDER_MODEL_LENGTH + 7);
      const id = isGemini && rawId.startsWith('models/') ? rawId.slice(7) : rawId;
      if (!id || id.length > MAX_PROVIDER_MODEL_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) {
        throw new TranslationFault('provider_failed');
      }
      return id;
    });

  let cursor: string | undefined;
  if (isGemini && value.nextPageToken) cursor = readBoundedString(value.nextPageToken, 2048);
  if (protocol === 'anthropic' && value.has_more === true) cursor = readBoundedString(value.last_id, 160);
  return { models, cursor };
}

function buildModelPageUrl(protocol: TranslationProtocol, baseUrl: string, cursor?: string): string {
  const url = new URL(`${baseUrl}/models`);
  if (protocol === 'gemini') url.searchParams.set('pageSize', '100');
  if (protocol === 'anthropic') url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set(protocol === 'gemini' ? 'pageToken' : 'after_id', cursor);
  return url.href;
}

export async function listProviderModels(options: {
  protocol: TranslationProtocol;
  baseUrl: string;
  apiKey: string;
  fetcher: ProviderFetch;
}): Promise<string[]> {
  const models = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const raw = await requestProviderText({
      url: buildModelPageUrl(options.protocol, options.baseUrl, cursor),
      init: { headers: buildProviderHeaders(options) },
      fetcher: options.fetcher,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TranslationFault('provider_failed');
    }
    const result = parseModelPage(options.protocol, parsed);
    for (const id of result.models) models.add(id);

    if (models.size > MAX_MODELS || result.models.some((id) => id.includes(options.apiKey))) {
      throw new TranslationFault('provider_failed');
    }
    if (!result.cursor) return [...models].sort();
    if (cursors.has(result.cursor)) throw new TranslationFault('provider_failed');
    cursors.add(result.cursor);
    cursor = result.cursor;
  }

  throw new TranslationFault('provider_failed');
}

export async function testProviderConnection(options: {
  connection: ProviderConnection;
  fetcher: ProviderFetch;
}): Promise<{ latencyMs: number; sample: string }> {
  const start = performance.now();
  const sample = await translateWithProvider({
    connection: options.connection,
    maskedText: '你好，有空的时候帮我看一下这条消息吧。',
    targetLanguage: 'en',
    fetcher: options.fetcher,
  });
  return {
    latencyMs: Math.round(performance.now() - start),
    sample,
  };
}
