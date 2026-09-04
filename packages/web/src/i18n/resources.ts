/**
 * The English catalogs, bundled so the fallback language is always present
 * and so i18next's key typing (see i18next.d.ts) can derive the set of
 * valid keys from real files instead of a hand-maintained type.
 *
 * Adding a namespace: add the file under every `src/locales/<lng>/`, import
 * the English one here, and add it to `en`. The consistency check keeps the
 * other languages honest.
 */
import common from '../locales/en/common.json';
import errors from '../locales/en/errors.json';
import settings from '../locales/en/settings.json';

export const defaultNS = 'common';

export const resources = {
  en: {
    common,
    errors,
    settings,
  },
} as const;

export type Namespace = keyof (typeof resources)['en'];

export const namespaces = Object.keys(resources.en) as Namespace[];
