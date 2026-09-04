import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { HttpError } from '../api/client';
import { describeError } from './errors';

let i18n: I18n;

beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({
    lng: 'de',
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common', 'errors'],
    resources: {
      en: {
        common: {},
        errors: {
          generic: 'Something went wrong.',
          recipient_deleted: 'That account was deleted.',
          username_too_long: 'Usernames can be at most {{max}} characters.',
        },
      },
      de: {
        common: {},
        errors: {
          generic: 'Etwas ist schiefgelaufen.',
          recipient_deleted: 'Dieses Konto wurde gelöscht.',
        },
      },
    },
  });
});

describe('describeError', () => {
  it('localizes a server error by its code', () => {
    const err = HttpError.fromBody(403, { error: "This user's account was deleted", code: 'recipient_deleted', statusCode: 403 });
    expect(describeError(err, i18n)).toBe('Dieses Konto wurde gelöscht.');
  });

  it('falls back to English for a code the selected language has not translated yet', () => {
    const err = HttpError.fromBody(400, { error: 'Username too long', code: 'username_too_long', statusCode: 400, details: { max: 32 } });
    expect(describeError(err, i18n)).toBe('Usernames can be at most 32 characters.');
  });

  it('shows the server text when the code has no catalog entry in any language', () => {
    const err = HttpError.fromBody(400, { error: 'Weird thing happened', code: 'peer_rejected', statusCode: 400 });
    expect(describeError(err, i18n)).toBe('Weird thing happened');
  });

  it('shows the server text when there is no code', () => {
    const err = HttpError.fromBody(500, { error: 'Database locked', statusCode: 500 });
    expect(describeError(err, i18n)).toBe('Database locked');
  });

  it('shows a plain error\'s message', () => {
    expect(describeError(new Error('Request timed out'), i18n)).toBe('Request timed out');
  });

  it('shows the generic message for anything without a usable message', () => {
    expect(describeError(undefined, i18n)).toBe('Etwas ist schiefgelaufen.');
    expect(describeError({}, i18n)).toBe('Etwas ist schiefgelaufen.');
    expect(describeError(new Error(''), i18n)).toBe('Etwas ist schiefgelaufen.');
  });
});

describe('HttpError.fromBody', () => {
  it('reads the code and details from a current-contract body', () => {
    const err = HttpError.fromBody(400, { error: 'x', code: 'username_too_long', statusCode: 400, details: { max: 32 } });
    expect(err.status).toBe(400);
    expect(err.message).toBe('x');
    expect(err.code).toBe('username_too_long');
    expect(err.details).toEqual({ max: 32 });
  });

  it('recognises an older peer that sent the code in the error field', () => {
    const err = HttpError.fromBody(400, { error: 'cannot_friend_self', statusCode: 400 });
    expect(err.code).toBe('cannot_friend_self');
    expect(err.message).toBe('cannot_friend_self');
  });

  it('leaves the code unset when the error text is not a known code', () => {
    const err = HttpError.fromBody(400, { error: 'Username is required', statusCode: 400 });
    expect(err.code).toBeUndefined();
  });

  it('ignores an unknown code so a newer peer cannot inject arbitrary keys', () => {
    const err = HttpError.fromBody(400, { error: 'x', code: 'not_a_real_code', statusCode: 400 });
    expect(err.code).toBeUndefined();
  });

  it('copes with a body that is not an object', () => {
    const err = HttpError.fromBody(502, null);
    expect(err.message).toBe('HTTP 502');
    expect(err.code).toBeUndefined();
  });
});
