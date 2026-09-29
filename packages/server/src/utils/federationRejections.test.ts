import { describe, it, expect } from 'vitest';
import { classifyRejection, isTerminalRejection } from './federationRejections.js';

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
