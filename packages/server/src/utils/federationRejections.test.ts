import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSIFIED_REASONS, classifyPulledRejection, classifyRejection, isTerminalRejection } from './federationRejections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('classifyRejection', () => {
  it.each([
    ['create', 'duplicate', 'taken'],
    ['friend_add', 'duplicate', 'taken'],
    ['delete', 'unknown_message', 'taken'],
    ['reaction_remove', 'unknown_message', 'taken'],
    ['update', 'unknown_message', 'retry'],
    ['reaction_add', 'unknown_message', 'retry'],
    ['create', 'channel_not_found', 'retry'],
    ['create', 'participant_not_found', 'retry'],
    ['create', 'author_not_found', 'retry'],
    ['reaction_add', 'user_not_found', 'retry'],
    ['friend_request_update', 'sender_not_found', 'retry'],
    ['group_metadata_update', 'actor_not_found', 'retry'],
    ['create', 'attribution_unproven', 'retry'],
    ['create', 'processing_error', 'retry'],
    ['create', 'unauthorized_source', 'retry'],
    ['member_add', 'max_members_exceeded', 'retry'],
    ['create', 'attribution_mismatch', 'refused'],
    ['friend_request_create', 'recipient_not_found', 'refused'],
    ['create', 'invalid_target', 'refused'],
    ['update', 'not_message_author', 'refused'],
    ['friend_request_create', 'self_target_invalid', 'refused'],
    ['presence_update', 'unknown_event_type', 'refused'],
    ['create', 'missing_message_payload', 'refused'],
    ['file_rejected', 'message_not_found', 'refused'],
    ['file_rejected', 'attachment_not_found', 'refused'],
  ] as const)('%s answered %s is %s', (eventType, reason, outcome) => {
    expect(classifyRejection(eventType, reason)).toBe(outcome);
  });

  it('treats a reason this build does not know as retry', () => {
    expect(classifyRejection('create', 'some_future_reason')).toBe('retry');
  });

  it('without a known event type, unknown_message is retry', () => {
    expect(classifyRejection(null, 'unknown_message')).toBe('retry');
  });

  it('isTerminalRejection is taken or refused', () => {
    expect(isTerminalRejection('create', 'duplicate')).toBe(true);
    expect(isTerminalRejection('create', 'attribution_mismatch')).toBe(true);
    expect(isTerminalRejection('create', 'channel_not_found')).toBe(false);
  });
});

describe('classifyPulledRejection', () => {
  it('classifies every listed reason as the outbox does', () => {
    for (const reason of CLASSIFIED_REASONS) {
      expect(classifyPulledRejection('create', reason)).toBe(classifyRejection('create', reason));
    }
  });

  it('drops a pulled event refused for a reason this build did not classify, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(classifyPulledRejection('create', 'some_unclassified_reason')).toBe('refused');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/**
 * Every reason the relay processors give, read from their source: a
 * `rejected.push` literal, or a member of a refusal type they return. The
 * pull drops an event refused for a reason missing from the lists, so a new
 * reason must be classified when it is added.
 */
function processorReasons(): Set<string> {
  const federationDir = path.resolve(__dirname, '../routes/federation');
  const files = [
    ...fs.readdirSync(path.join(federationDir, 'events')).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => path.join(federationDir, 'events', f)),
    path.join(federationDir, 'profile.ts'),
    path.join(federationDir, 'identity.ts'),
    path.join(federationDir, 'dmChannels.ts'),
  ];
  const reasonLine = /rejected\.push|reason: '|type AttributionRefusal =|\): '[a-z_]+' \|/;
  const reasons = new Set<string>();
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!reasonLine.test(line) || line.includes('undeliverable.push')) continue;
      for (const match of line.matchAll(/'([a-z]+(?:_[a-z]+)+)'/g)) reasons.add(match[1]!);
    }
  }
  return reasons;
}

describe('the classification lists', () => {
  it('name every reason a relay processor gives', () => {
    const reasons = processorReasons();
    expect(reasons.size).toBeGreaterThan(20);
    expect([...reasons].filter(reason => !CLASSIFIED_REASONS.has(reason))).toEqual([]);
  });
});
