import i18n from '../../i18n';
import type { TranslationReply } from '@backspace/shared/translation';
export function translationErrorText(error: Extract<TranslationReply, { ok: false }>): string {
  const message = i18n.t(`translation:errors.${error.code}`);
  return error.status === undefined ? message : `${message} (HTTP ${error.status})`;
}
