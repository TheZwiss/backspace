import type { TranslationReply } from '../../shared/src/translation';
import { aiHeaders, translateAi } from './aiProtocols';
import { parseJson, requestText, type TranslationFetch } from './transport';
import { TranslationError, record, string } from './validation';
import type { StoredConnection } from './vault';

const MAX_MODEL_PAGES = 20;
const MAX_MODELS = 1000;
interface DiagnosticRequest { connection: StoredConnection; fetcher: TranslationFetch }
function modelPage(connection: StoredConnection, raw: unknown) {
  const value = record(raw);
  const gemini = connection.protocol === 'gemini';
  const rows = gemini ? value.models : value.data;
  if (!Array.isArray(rows)) throw new TranslationError('invalid-response');
  const models = rows.map(record).filter(row => !gemini ||
    (Array.isArray(row.supportedGenerationMethods) && row.supportedGenerationMethods.includes('generateContent'))
  ).map(row => {
    const rawId = string(gemini ? row.name : row.id, 167);
    const id = gemini ? rawId.replace(/^models\//, '') : rawId;
    if (id.length > 160 || /[\u0000-\u001f\u007f]/.test(id)) throw new TranslationError('invalid-response');
    return id;
  });
  let cursor: string | undefined;
  if (gemini && value.nextPageToken) cursor = string(value.nextPageToken, 2048);
  if (connection.protocol === 'anthropic' && value.has_more === true) cursor = string(value.last_id, 160);
  return { models, cursor };
}
function modelPageUrl(connection: StoredConnection, cursor?: string): string {
  const url = new URL(connection.baseUrl + '/models');
  if (connection.protocol === 'gemini') url.searchParams.set('pageSize', '100');
  if (connection.protocol === 'anthropic') url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set(connection.protocol === 'gemini' ? 'pageToken' : 'after_id', cursor);
  return url.href;
}
export async function listModels({ connection, fetcher }: DiagnosticRequest): Promise<string[]> {
  const models = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const raw = await requestText({ url: modelPageUrl(connection, cursor), init: { headers: aiHeaders(connection) }, fetcher });
    let result: ReturnType<typeof modelPage>;
    try { result = modelPage(connection, parseJson(raw)); }
    catch { throw new TranslationError('invalid-response'); }
    result.models.forEach(id => models.add(id));
    // Inspect decoded IDs: escaped JSON must not smuggle a saved credential back to the renderer.
    const secret = connection.apiKey;
    if (models.size > MAX_MODELS || (secret && result.models.some(id => id.includes(secret))))
      throw new TranslationError('invalid-response');
    if (!result.cursor) return [...models].sort();
    if (cursors.has(result.cursor)) throw new TranslationError('invalid-response');
    cursors.add(result.cursor);
    cursor = result.cursor;
  }
  // Never present a partial listing as the complete available model set.
  throw new TranslationError('invalid-response');
}
export async function testConnection(options: DiagnosticRequest): Promise<Extract<TranslationReply, { test: unknown }>['test']> {
  const start = performance.now();
  // Explicit user action: a small fixed sample, no chat history, no settings/consent mutation or result cache.
  const text = await translateAi({ ...options, text: '你好，有空的时候帮我看一下这条消息吧。', target: 'en' });
  if (!text.trim() || text.length > 2000 || (options.connection.apiKey && text.includes(options.connection.apiKey)))
    throw new TranslationError('invalid-response');
  return { latencyMs: Math.round(performance.now() - start), text };
}
