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
    case 'openai-chat':
      return {
        path: '/chat/completions',
        body: { model: connection.model, messages, stream: false },
      };
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
const RESPONSE_READERS: Record<StoredConnection['protocol'], (response: Record<string, unknown>) => unknown> =
  {
    'openai-chat': (response) => {
      const choice = responseParts(response.choices)[0];
      if (choice?.finish_reason !== 'stop') throw new TranslationError('invalid-response');
      const message = record(choice.message);
      if (message.tool_calls || message.function_call) throw new TranslationError('invalid-response');
      return message.content;
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
  const authHeader = {
    'openai-chat': 'Authorization',
    'openai-responses': 'Authorization',
    anthropic: 'x-api-key',
    gemini: 'x-goog-api-key',
  }[connection.protocol];
  if (connection.apiKey)
    headers[authHeader] = authHeader === 'Authorization' ? `Bearer ${connection.apiKey}` : connection.apiKey;
  return headers;
}
export async function translateAi(options: AiRequest): Promise<string> {
  const { connection, fetcher } = options;
  const request = payloadFor(options);
  const headers = aiHeaders(connection);
  const response = await requestText({
    url: `${connection.baseUrl}${request.path}`,
    init: { method: 'POST', headers, body: JSON.stringify(request.body) },
    fetcher,
  });
  try {
    const text = RESPONSE_READERS[connection.protocol](record(parseJson(response)));
    if (typeof text !== 'string') throw new TranslationError('invalid-response');
    const output = record(parseJson(text));
    if (Object.keys(output).length !== 1)
      throw new TranslationError('invalid-response');
    return messageOutput(options.text, output.translation);
  } catch {
    throw new TranslationError('invalid-response');
  }
}
