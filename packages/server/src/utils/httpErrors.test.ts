import { describe, it, expect, vi } from 'vitest';
import { ERROR_CODES } from '@backspace/shared/src/errors';
import { sendError, ERROR_MESSAGES } from './httpErrors';

function fakeReply() {
  const reply = {
    code: vi.fn(),
    send: vi.fn(),
  };
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply;
}

describe('sendError', () => {
  it('sends the status, the English text, the code and the status code', () => {
    const reply = fakeReply();
    sendError(reply as never, 403, 'recipient_deleted');
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      error: ERROR_MESSAGES.recipient_deleted,
      code: 'recipient_deleted',
      statusCode: 403,
    });
  });

  it('interpolates details into the English text and forwards them for the client', () => {
    const reply = fakeReply();
    sendError(reply as never, 400, 'username_too_long', { max: 32 });
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Usernames can be at most 32 characters',
      code: 'username_too_long',
      statusCode: 400,
      details: { max: 32 },
    });
  });

  it('returns the reply so a route can `return sendError(...)`', () => {
    const reply = fakeReply();
    expect(sendError(reply as never, 404, 'not_found')).toBe(reply);
  });
});

describe('ERROR_MESSAGES', () => {
  it('has English text for every shared error code', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGES[code], code).toBeTypeOf('string');
      expect(ERROR_MESSAGES[code].length, code).toBeGreaterThan(0);
    }
  });

  it('references only placeholders that a caller can fill', () => {
    for (const [code, text] of Object.entries(ERROR_MESSAGES)) {
      for (const placeholder of text.matchAll(/\{\{(\w+)\}\}/g)) {
        expect(['min', 'max', 'permission', 'roleId', 'id'], `${code} uses {{${placeholder[1]}}}`).toContain(placeholder[1]);
      }
    }
  });
});
