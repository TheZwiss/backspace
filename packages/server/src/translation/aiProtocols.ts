import type { TranslationLanguage, TranslationProtocol } from '@backspace/shared/src/translation.js';
import { asRecord, TranslationFault } from './errors.js';
import { buildUntrustedMessageInput, reconstructMessageOutput } from './messageLines.js';
import { TRANSLATION_PROMPT } from './prompt.js';
import { requestProviderText, type ProviderFetch } from './providerFetch.js';

export interface ProviderConnection {
  protocol: TranslationProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function buildProviderRequest(input: {
  connection: ProviderConnection;
  maskedText: string;
  targetLanguage: TranslationLanguage;
}): { path: string; body: Record<string, unknown> } {
  // Minimum required payload: target language code + masked message text only.
  // Author, channel, space, message ID, timestamps, and history never leave the instance.
  const content = JSON.stringify({
    targetLanguage: input.targetLanguage,
    untrustedText: buildUntrustedMessageInput(input.maskedText),
  });
  const messages = [
    { role: 'system', content: TRANSLATION_PROMPT },
    { role: 'user', content },
  ];

  switch (input.connection.protocol) {
    case 'openai-chat': {
      const isReasoner = input.connection.model.toLowerCase().includes('reasoner');
      return {
        path: '/chat/completions',
        body: {
          model: input.connection.model,
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
          model: input.connection.model,
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
          model: input.connection.model,
          system: TRANSLATION_PROMPT,
          messages: [{ role: 'user', content }],
          max_tokens: 4096,
        },
      };
    case 'gemini':
      return {
        path: `/models/${encodeURIComponent(input.connection.model)}:generateContent`,
        body: {
          systemInstruction: { parts: [{ text: TRANSLATION_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: content }] }],
          generationConfig: { responseMimeType: 'application/json' },
        },
      };
  }
}

export function buildProviderHeaders(connection: Pick<ProviderConnection, 'protocol' | 'apiKey'>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (connection.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    headers['x-api-key'] = connection.apiKey;
  } else if (connection.protocol === 'gemini') {
    headers['x-goog-api-key'] = connection.apiKey;
  } else {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  }
  return headers;
}

function asObjectList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TranslationFault('provider_failed');
  return value.map(asRecord);
}

function joinTextParts(parts: Record<string, unknown>[]): string {
  return parts
    .map((part) => {
      if (typeof part.text !== 'string') throw new TranslationFault('provider_failed');
      return part.text;
    })
    .join('');
}

function extractModelText(protocol: TranslationProtocol, response: Record<string, unknown>): string {
  switch (protocol) {
    case 'openai-chat': {
      const choice = asObjectList(response.choices)[0];
      if (choice?.finish_reason === 'content_filter') throw new TranslationFault('protected_content');
      if (choice?.finish_reason !== 'stop') throw new TranslationFault('provider_failed');
      const message = asRecord(choice.message);
      if (message.tool_calls || message.function_call) throw new TranslationFault('provider_failed');
      if (typeof message.content === 'string') return message.content;
      throw new TranslationFault('provider_failed');
    }
    case 'openai-responses': {
      if (response.status !== 'completed') throw new TranslationFault('provider_failed');
      const output = asObjectList(response.output);
      if (output.some((part) => !['message', 'reasoning'].includes(String(part.type)))) {
        throw new TranslationFault('provider_failed');
      }
      const parts = output
        .filter((part) => part.type === 'message')
        .flatMap((part) => asObjectList(part.content));
      if (parts.some((part) => part.type !== 'output_text')) throw new TranslationFault('provider_failed');
      return joinTextParts(parts);
    }
    case 'anthropic': {
      if (response.stop_reason !== 'end_turn') throw new TranslationFault('provider_failed');
      const parts = asObjectList(response.content);
      if (parts.some((part) => !['text', 'thinking', 'redacted_thinking'].includes(String(part.type)))) {
        throw new TranslationFault('provider_failed');
      }
      return joinTextParts(parts.filter((part) => part.type === 'text'));
    }
    case 'gemini': {
      const candidate = asObjectList(response.candidates)[0];
      if (candidate?.finishReason !== 'STOP') throw new TranslationFault('provider_failed');
      const parts = asObjectList(asRecord(candidate.content).parts);
      if (parts.some((part) => part.functionCall || part.executableCode)) {
        throw new TranslationFault('provider_failed');
      }
      return joinTextParts(parts.filter((part) => !part.thought));
    }
  }
}

export function extractTranslationJson(rawText: string): Record<string, unknown> {
  const text = rawText.trim();
  try {
    return asRecord(JSON.parse(text));
  } catch {
    // Fall through to bounded fence / brace extraction
  }

  const fenceStart = text.indexOf('```');
  if (fenceStart !== -1) {
    const fenceEnd = text.indexOf('```', fenceStart + 3);
    if (fenceEnd !== -1) {
      let block = text.slice(fenceStart + 3, fenceEnd).trim();
      if (block.toLowerCase().startsWith('json')) {
        block = block.slice(4).trim();
      }
      try {
        return asRecord(JSON.parse(block));
      } catch {
        // Fall through
      }
    }
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return asRecord(JSON.parse(text.slice(firstBrace, lastBrace + 1)));
    } catch {
      // Fall through
    }
  }

  throw new TranslationFault('provider_failed');
}

export async function translateWithProvider(options: {
  connection: ProviderConnection;
  maskedText: string;
  targetLanguage: TranslationLanguage;
  fetcher: ProviderFetch;
}): Promise<string> {
  const reqPayload = buildProviderRequest(options);
  const rawResponse = await requestProviderText({
    url: `${options.connection.baseUrl}${reqPayload.path}`,
    init: {
      method: 'POST',
      headers: buildProviderHeaders(options.connection),
      body: JSON.stringify(reqPayload.body),
    },
    fetcher: options.fetcher,
  });

  let parsedResponse: Record<string, unknown>;
  try {
    parsedResponse = asRecord(JSON.parse(rawResponse));
  } catch {
    throw new TranslationFault('provider_failed');
  }

  const modelText = extractModelText(options.connection.protocol, parsedResponse);
  const jsonOutput = extractTranslationJson(modelText);
  if (Object.keys(jsonOutput).length !== 1 || jsonOutput.translation === undefined) {
    throw new TranslationFault('provider_failed');
  }

  const reconstructed = reconstructMessageOutput(options.maskedText, jsonOutput.translation);
  if (options.connection.apiKey && reconstructed.includes(options.connection.apiKey)) {
    throw new TranslationFault('provider_failed');
  }
  return reconstructed;
}
