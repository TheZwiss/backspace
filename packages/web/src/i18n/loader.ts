/**
 * Loads translation catalogs on demand.
 *
 * English is bundled with the app (see resources.ts) so the fallback is
 * always present. Every other language is a set of lazy imports that Vite
 * splits into their own chunks: a Russian user downloads the Russian
 * catalogs and nothing else, and an English user downloads none.
 */
const catalogs = import.meta.glob<Record<string, unknown>>('../locales/*/*.json', { import: 'default' });

const PATH_PATTERN = /^\.\.\/locales\/([^/]+)\/([^/]+)\.json$/;

export interface CatalogPath {
  language: string;
  namespace: string;
}

/** Every catalog file the build can see, whether or not it is ever loaded. */
export function listCatalogPaths(): CatalogPath[] {
  const paths: CatalogPath[] = [];
  for (const path of Object.keys(catalogs)) {
    const match = PATH_PATTERN.exec(path);
    if (match) paths.push({ language: match[1]!, namespace: match[2]! });
  }
  return paths;
}

export class LazyCatalogBackend {
  static readonly type = 'backend' as const;
  readonly type = 'backend' as const;

  init(): void {
    // No options: the catalog set is fixed at build time by the glob above.
  }

  async read(language: string, namespace: string): Promise<Record<string, unknown>> {
    const load = catalogs[`../locales/${language}/${namespace}.json`];
    if (!load) {
      throw new Error(`No catalog for ${language}/${namespace}`);
    }
    return load();
  }
}
