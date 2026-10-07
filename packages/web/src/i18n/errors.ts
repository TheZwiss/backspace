import type { i18n as I18n } from 'i18next';
import { HttpError } from '../api/client';
import defaultI18n from './index';

/**
 * Turn anything a request can throw into words in the user's language.
 *
 * Preference order: the localized text for the server's error code, then
 * the server's own English `error` text (an unconverted route, or a peer on
 * an older version), then the message of a plain Error, then the generic
 * fallback. Interpolation values arrive as `details` on the error body.
 */
export function describeError(err: unknown, instance: I18n = defaultI18n): string {
  if (err instanceof HttpError && err.code) {
    return describeErrorCode(err.code, err.message, err.details, instance);
  }
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message;
  }
  return instance.t('errors:generic');
}

/**
 * The words for a server error code, from any protocol that carries one (an
 * HTTP error body, a WebSocket `error` event): the localized text for the
 * code, else the server's own English `message`, else the generic fallback.
 */
export function describeErrorCode(
  code: string,
  message: string,
  details?: Record<string, string | number>,
  instance: I18n = defaultI18n,
): string {
  const key = `errors:${code}`;
  if (instance.exists(key)) {
    return instance.t(key, { ...details, defaultValue: message });
  }
  return message.trim().length > 0 ? message : instance.t('errors:generic');
}
