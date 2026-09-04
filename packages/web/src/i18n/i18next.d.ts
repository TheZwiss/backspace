import 'i18next';
import type { resources, defaultNS } from './resources';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: (typeof resources)['en'];
    returnNull: false;
  }
}
