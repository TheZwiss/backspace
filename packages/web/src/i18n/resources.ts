/**
 * The English catalogs, bundled so the fallback language is always present
 * and so i18next's key typing (see i18next.d.ts) can derive the set of
 * valid keys from real files instead of a hand-maintained type.
 *
 * Adding a namespace: add the file under every `src/locales/<lng>/`, import
 * the English one here, and add it to `en`. The consistency check keeps the
 * other languages honest.
 */
import admin from '../locales/en/admin.json';
import auth from '../locales/en/auth.json';
import chat from '../locales/en/chat.json';
import common from '../locales/en/common.json';
import desktop from '../locales/en/desktop.json';
import dm from '../locales/en/dm.json';
import errors from '../locales/en/errors.json';
import federation from '../locales/en/federation.json';
import mobile from '../locales/en/mobile.json';
import search from '../locales/en/search.json';
import settings from '../locales/en/settings.json';
import social from '../locales/en/social.json';
import spaces from '../locales/en/spaces.json';
import uploads from '../locales/en/uploads.json';
import voice from '../locales/en/voice.json';

export const defaultNS = 'common';

export const resources = {
  en: {
    admin,
    auth,
    chat,
    common,
    desktop,
    dm,
    errors,
    federation,
    mobile,
    search,
    settings,
    social,
    spaces,
    uploads,
    voice,
  },
} as const;

export type Namespace = keyof (typeof resources)['en'];

export const namespaces = Object.keys(resources.en) as Namespace[];
