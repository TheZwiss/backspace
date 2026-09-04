import { describe, it, expect } from 'vitest';
import { LazyCatalogBackend, listCatalogPaths } from './loader';

describe('LazyCatalogBackend', () => {
  it('loads a namespace for a shipped language from its own catalog file', async () => {
    const backend = new LazyCatalogBackend();
    const catalog = await backend.read('ru', 'common');
    expect(catalog).toBeTypeOf('object');
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
  });

  it('rejects a language that is not shipped', async () => {
    const backend = new LazyCatalogBackend();
    await expect(backend.read('fr', 'common')).rejects.toThrow(/fr\/common/);
  });

  it('rejects a namespace that does not exist', async () => {
    const backend = new LazyCatalogBackend();
    await expect(backend.read('ru', 'nope')).rejects.toThrow(/ru\/nope/);
  });

  it('identifies itself to i18next as a backend', () => {
    expect(LazyCatalogBackend.type).toBe('backend');
  });
});

describe('listCatalogPaths', () => {
  it('sees every shipped language directory', () => {
    const languages = new Set(listCatalogPaths().map((p) => p.language));
    expect([...languages].sort()).toEqual(['de', 'en', 'ru']);
  });

  it('sees the same namespaces for every language', () => {
    const byLanguage = new Map<string, string[]>();
    for (const { language, namespace } of listCatalogPaths()) {
      byLanguage.set(language, [...(byLanguage.get(language) ?? []), namespace].sort());
    }
    const [first, ...rest] = [...byLanguage.values()];
    for (const namespaces of rest) expect(namespaces).toEqual(first);
  });
});
