import { createHash } from 'crypto';
import type { TranslationLanguage } from '../../shared/src/translation';
import type { StoredConnection } from './vault';
import { TRANSLATION_PROMPT_VERSION } from './prompt';

// A policy change must not reuse an output validated against older text/protection rules.
const TEXT_POLICY_VERSION = 1;
export const RESULT_CACHE_LIMIT = 1000;
export const RESULT_CACHE_BYTES = 16 * 1024 * 1024;
export const MAX_RESULT_LENGTH = 24000;

export function translationResultKey(input: {
  text: string;
  target: TranslationLanguage;
  engine: string;
  connection?: StoredConnection;
}): string {
  const { connection } = input;
  // Names, credentials, display settings and message IDs do not change translation semantics.
  const provider = connection ? [connection.protocol, connection.baseUrl, connection.model] : input.engine;
  return createHash('sha256')
    .update(
      JSON.stringify([TEXT_POLICY_VERSION, TRANSLATION_PROMPT_VERSION, provider, input.target, input.text]),
    )
    .digest('hex');
}

export interface ResultCache {
  get(scope: string, key: string): string | null;
  set(scope: string, key: string, text: string): void;
}
