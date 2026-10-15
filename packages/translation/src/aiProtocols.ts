import type { TranslationLanguage } from '../../shared/src/translation';
import type { StoredConnection } from './vault';
import { messageInput, messageOutput } from './messageLines';
import { TRANSLATION_PROMPT } from './prompt';
import { parseJson, requestText, type TranslationFetch } from './transport';
import { TranslationError, record } from './validation';
interface AiRequest {
  connection: StoredConnection;
  text: string;
  target: TranslationLanguage;
  fetcher: TranslationFetch;
}
function payloadFor({ connection, text, target }: Omit<AiRequest, 'fetcher'>) {
  const content = JSON.stringify({
    targetLanguage: target,
    untrustedText: messageInput(text),
  });
  const messages = [
    { role: 'system', content: TRANSLATION_PROMPT },
    { role: 'user', content },
  ];
  switch (connection.protocol) {
    case 'openai-chat': {
      const isReasoner = connection.model?.toLowerCase().includes('reasoner');
      return {
        path: '/chat/completions',
        body: {
          model: connection.model,
          messages,
          stream: false,
          ...(isReasoner ? {} : { response_format: { type: 'json_object' } }),
        },
      };
    }
    case 'openai-responses':
      return {
        path: '/responses',
        body: {
          model: connection.model,
          instructions: TRANSLATION_PROMPT,
          input: content,
          store: false,
          stream: false,
        },
      };
    case 'anthropic':
      return {
        path: '/messages',
        body: {
          model: connection.model,
          system: TRANSLATION_PROMPT,
          messages: [{ role: 'user', content }],
          max_tokens: 8192,
        },
      };
    case 'gemini':
      return {
        path: `/models/${encodeURIComponent(connection.model)}:generateContent`,
        body: {
          systemInstruction: { parts: [{ text: TRANSLATION_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: content }] }],
          generationConfig: { responseMimeType: 'application/json' },
        },
      };
  }
}
function responseParts(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TranslationError('invalid-response');
  return value.map(record);
}
function joinedText(parts: Record<string, unknown>[]): string {
  return parts
    .map((part) => {
      if (typeof part.text !== 'string') throw new TranslationError('invalid-response');
      return part.text;
    })
    .join('');
}
type LlmProtocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
const RESPONSE_READERS: Record<LlmProtocol, (response: Record<string, unknown>) => unknown> =
  {
    'openai-chat': (response) => {
      const choice = responseParts(response.choices)[0];
      if (choice?.finish_reason === 'content_filter') throw new TranslationError('protected-content');
      if (choice?.finish_reason !== 'stop') throw new TranslationError('invalid-response');
      const message = record(choice?.message);
      if (message.tool_calls || message.function_call) throw new TranslationError('invalid-response');
      if (typeof message.content === 'string') return message.content;
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
        return message.reasoning_content;
      }
      throw new TranslationError('invalid-response');
    },
    'openai-responses': (response) => {
      if (response.status !== 'completed') throw new TranslationError('invalid-response');
      const output = responseParts(response.output);
      if (output.some((part) => !['message', 'reasoning'].includes(String(part.type))))
        throw new TranslationError('invalid-response');
      const parts = output
        .filter((part) => part.type === 'message')
        .flatMap((part) => responseParts(part.content));
      if (parts.some((part) => part.type !== 'output_text')) throw new TranslationError('invalid-response');
      return joinedText(parts);
    },
    anthropic: (response) => {
      if (response.stop_reason !== 'end_turn') throw new TranslationError('invalid-response');
      const parts = responseParts(response.content);
      if (parts.some((part) => !['text', 'thinking', 'redacted_thinking'].includes(String(part.type))))
        throw new TranslationError('invalid-response');
      return joinedText(parts.filter((part) => part.type === 'text'));
    },
    gemini: (response) => {
      const candidate = responseParts(response.candidates)[0];
      if (candidate?.finishReason !== 'STOP') throw new TranslationError('invalid-response');
      const parts = responseParts(record(candidate.content).parts);
      if (parts.some((part) => part.functionCall || part.executableCode))
        throw new TranslationError('invalid-response');
      return joinedText(parts.filter((part) => !part.thought));
    },
  };
export function aiHeaders(connection: StoredConnection): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (connection.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (connection.protocol === 'microsoft-translator') {
    if (connection.apiKey) headers['Ocp-Apim-Subscription-Key'] = connection.apiKey;
    if (connection.model && connection.model !== 'general' && connection.model !== 'default') {
      headers['Ocp-Apim-Subscription-Region'] = connection.model;
    }
    return headers;
  }
  const authHeader = {
    'openai-chat': 'Authorization',
    'openai-responses': 'Authorization',
    anthropic: 'x-api-key',
    gemini: 'x-goog-api-key',
    'google-translate': 'x-goog-api-key',
  }[connection.protocol];
  if (connection.apiKey && authHeader)
    headers[authHeader] = authHeader === 'Authorization' ? `Bearer ${connection.apiKey}` : connection.apiKey;
  return headers;
}

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) {
    end--;
  }
  return url.slice(0, end);
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&#x2F;': '/',
  '&#x2f;': '/',
};

function unescapeHtml(str: string): string {
  return str.replace(/&(?:amp|lt|gt|quot|#39|#x27|#x2[Ff]);/g, (m) => HTML_ENTITIES[m] ?? m);
}

async function translateGoogle(options: AiRequest): Promise<string> {
  const { connection, text, target, fetcher } = options;
  const url = `${stripTrailingSlashes(connection.baseUrl)}/language/translate/v2`;
  const headers = aiHeaders(connection);
  const body = JSON.stringify({
    q: [text],
    target,
    format: 'text',
    model: connection.model && connection.model !== 'default' ? connection.model : 'nmt',
  });
  const response = await requestText({
    url,
    init: { method: 'POST', headers, body },
    fetcher,
  });
  try {
    const res = record(parseJson(response));
    const data = record(res.data);
    if (!Array.isArray(data.translations) || !data.translations.length) {
      throw new TranslationError('invalid-response');
    }
    const item = record(data.translations[0]);
    if (typeof item.translatedText !== 'string' || !item.translatedText.trim()) {
      throw new TranslationError('invalid-response');
    }
    return unescapeHtml(item.translatedText);
  } catch (e) {
    if (e instanceof TranslationError) throw e;
    throw new TranslationError('invalid-response');
  }
}

async function translateMicrosoft(options: AiRequest): Promise<string> {
  const { connection, text, target, fetcher } = options;
  const msTarget = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' }[target as 'zh-CN' | 'zh-TW'] ?? target;
  const url = `${stripTrailingSlashes(connection.baseUrl)}/translate?api-version=3.0&to=${encodeURIComponent(msTarget)}`;
  const headers = aiHeaders(connection);
  const body = JSON.stringify([{ Text: text }]);
  const response = await requestText({
    url,
    init: { method: 'POST', headers, body },
    fetcher,
  });
  try {
    const list = parseJson(response);
    if (!Array.isArray(list) || !list.length) {
      throw new TranslationError('invalid-response');
    }
    const first = record(list[0]);
    if (!Array.isArray(first.translations) || !first.translations.length) {
      throw new TranslationError('invalid-response');
    }
    const item = record(first.translations[0]);
    if (typeof item.text !== 'string' || !item.text.trim()) {
      throw new TranslationError('invalid-response');
    }
    return item.text;
  } catch (e) {
    if (e instanceof TranslationError) throw e;
    throw new TranslationError('invalid-response');
  }
}

export function extractTranslationJson(rawText: string): Record<string, unknown> {
  const text = rawText.trim();
  try {
    return record(JSON.parse(text));
  } catch {}

  const fenceStart = text.indexOf('```');
  if (fenceStart !== -1) {
    const fenceEnd = text.indexOf('```', fenceStart + 3);
    if (fenceEnd !== -1) {
      let block = text.slice(fenceStart + 3, fenceEnd).trim();
      if (block.toLowerCase().startsWith('json')) {
        block = block.slice(4).trim();
      }
      try {
        return record(JSON.parse(block));
      } catch {}
    }
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return record(JSON.parse(text.slice(firstBrace, lastBrace + 1)));
    } catch {}
  }

  throw new TranslationError('invalid-response');
}

export async function translateAi(options: AiRequest): Promise<string> {
  if (options.connection.protocol === 'google-translate') {
    return await translateGoogle(options);
  }
  if (options.connection.protocol === 'microsoft-translator') {
    return await translateMicrosoft(options);
  }
  const { connection, fetcher } = options;
  const request = payloadFor(options)!;
  const headers = aiHeaders(connection);
  const response = await requestText({
    url: `${connection.baseUrl}${request.path}`,
    init: { method: 'POST', headers, body: JSON.stringify(request.body) },
    fetcher,
  });
  try {
    const text = RESPONSE_READERS[connection.protocol as keyof typeof RESPONSE_READERS](record(parseJson(response)));
    if (typeof text !== 'string') throw new TranslationError('invalid-response');
    const output = extractTranslationJson(text);
    if (Object.keys(output).length !== 1 || output.translation === undefined)
      throw new TranslationError('invalid-response');
    return messageOutput(options.text, output.translation);
  } catch {
    throw new TranslationError('invalid-response');
  }
}

export async function generateAi(options: {
  connection: StoredConnection;
  systemPrompt?: string;
  userPrompt: string;
  fetcher: TranslationFetch;
}): Promise<string> {
  const { connection, systemPrompt, userPrompt, fetcher } = options;
  const isReasoner = connection.model?.toLowerCase().includes('reasoner');
  const messages: Array<{ role: string; content: string }> = [];
  if (isReasoner && systemPrompt?.trim()) {
    messages.push({ role: 'user', content: `${systemPrompt.trim()}\n\n${userPrompt}` });
  } else {
    if (systemPrompt?.trim()) {
      messages.push({ role: 'system', content: systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: userPrompt });
  }

  let path = '/chat/completions';
  let body: Record<string, unknown> = {
    model: connection.model,
    messages,
    stream: false,
  };

  switch (connection.protocol) {
    case 'openai-chat':
      path = '/chat/completions';
      body = { model: connection.model, messages, stream: false };
      break;
    case 'openai-responses':
      path = '/responses';
      body = {
        model: connection.model,
        instructions: systemPrompt ?? '',
        input: userPrompt,
        store: false,
        stream: false,
      };
      break;
    case 'anthropic':
      path = '/messages';
      body = {
        model: connection.model,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 8192,
      };
      break;
    case 'gemini':
      path = `/models/${encodeURIComponent(connection.model)}:generateContent`;
      body = {
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      };
      break;
    default:
      throw new TranslationError('invalid-input');
  }

  const headers = aiHeaders(connection);
  const response = await requestText({
    url: `${connection.baseUrl}${path}`,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
    timeoutMs: 90_000,
    fetcher,
  });

  const parsed = record(parseJson(response));
  const rawText = RESPONSE_READERS[connection.protocol as keyof typeof RESPONSE_READERS](parsed);
  if (typeof rawText !== 'string') throw new TranslationError('invalid-response');
  return rawText.trim();
}

