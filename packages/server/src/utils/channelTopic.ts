import { CHANNEL_TOPIC_MAX_LENGTH, normalizeChannelTopic } from '@backspace/shared/src/constants.js';
import type { ErrorCode, ErrorDetails } from '@backspace/shared/src/errors.js';

export type ChannelTopicCheck =
  | { ok: true; topic: string | null }
  | { ok: false; code: Extract<ErrorCode, 'channel_topic_invalid' | 'channel_topic_length'>; details?: ErrorDetails };

/**
 * Validates a topic from a channel create or update body and returns the form
 * it is stored in (`normalizeChannelTopic`). `null` clears the topic. Anything
 * that is neither a string nor `null` is refused, as is a topic longer than
 * `CHANNEL_TOPIC_MAX_LENGTH` once normalized. A long topic is refused rather
 * than cut, so the stored text is always what its author saw in the field.
 */
export function checkChannelTopic(raw: unknown): ChannelTopicCheck {
  if (raw === null) return { ok: true, topic: null };
  if (typeof raw !== 'string') return { ok: false, code: 'channel_topic_invalid' };
  const topic = normalizeChannelTopic(raw);
  if (topic !== null && topic.length > CHANNEL_TOPIC_MAX_LENGTH) {
    return { ok: false, code: 'channel_topic_length', details: { max: CHANNEL_TOPIC_MAX_LENGTH } };
  }
  return { ok: true, topic };
}
