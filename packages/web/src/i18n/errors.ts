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
    const key = `errors:${err.code}`;
    if (instance.exists(key)) {
      return instance.t(key, { ...err.details, defaultValue: err.message });
    }
  }
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message;
  }
  return instance.t('errors:generic');
}
