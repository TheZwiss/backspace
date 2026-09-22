import { describe, it, expect } from 'vitest';
import ruSpaces from '../locales/ru/spaces.json';
import ruAdmin from '../locales/ru/admin.json';
import ruErrors from '../locales/ru/errors.json';
import enSpaces from '../locales/en/spaces.json';
import enErrors from '../locales/en/errors.json';

/**
 * One Russian name for the space directory, and never that name for
 * something else.
 *
 * The Russian catalog carried three names for it (внешний каталог,
 * общедоступный каталог, bare каталог) and also used «каталог пространств»
 * for *discovery*, which is a different setting with a different switch: a
 * space owner reading "the directory is disabled" went looking for the
 * listing control when what was off was discovery. The name settled on is
 * «внешний каталог», the spelling that was already in the majority and the
 * one that matches «внешнее пространство» for Outer Space.
 *
 * The parity check in `scripts/i18n` compares languages to each other and
 * cannot see any of this, so the rule lives here.
 */

type Catalog = { [key: string]: string | Catalog };

function entries(catalog: Catalog, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.push([path, value]);
    else out.push(...entries(value, path));
  }
  return out;
}

const RU_CATALOGS: [string, Catalog][] = [
  ['spaces', ruSpaces as Catalog],
  ['admin', ruAdmin as Catalog],
  ['errors', ruErrors as Catalog],
];

// `\w` is ASCII-only in JavaScript, so every pattern here is built from
// `\p{L}` with the `u` flag; a `\w`-based one matches the Latin half of a
// Cyrillic word and reports every line in the catalog.
/** The words of a string, punctuation and quotes dropped. */
const WORDS = /\p{L}+/gu;
/** Any case of каталог: каталоге, каталогом, каталогу… */
const DIRECTORY = /^катало\p{L}*$/iu;
/** The one modifier that name takes, in any case: внешний, внешнем, внешним… */
const EXTERNAL = /^внешн\p{L}*$/iu;

describe('the Russian name for the space directory', () => {
  it('is «внешний каталог» wherever the directory is named', () => {
    const wrong: string[] = [];
    for (const [ns, catalog] of RU_CATALOGS) {
      for (const [key, value] of entries(catalog)) {
        const words = value.match(WORDS) ?? [];
        words.forEach((word, at) => {
          if (!DIRECTORY.test(word)) return;
          const before = words[at - 1] ?? '';
          if (!EXTERNAL.test(before)) wrong.push(`${ns}:${key} -> "${before} ${word}"`);
        });
      }
    }
    expect(wrong).toEqual([]);
  });

  it('never uses it for discovery, which is «обнаружение пространств»', () => {
    // The three strings that are about the discovery setting and used to
    // name the directory instead. Their English is the check: each one says
    // "discovery", and none of them says "directory".
    const cases: [string, string, string][] = [
      ['spaces:join.discoveryOff', (enSpaces as Catalog & { join: { discoveryOff: string } }).join.discoveryOff,
        (ruSpaces as Catalog & { join: { discoveryOff: string } }).join.discoveryOff],
      ['spaces:settings.discovery.disabledNotice',
        (enSpaces as unknown as { settings: { discovery: { disabledNotice: string } } }).settings.discovery.disabledNotice,
        (ruSpaces as unknown as { settings: { discovery: { disabledNotice: string } } }).settings.discovery.disabledNotice],
      ['errors:directory_requires_discovery',
        (enErrors as unknown as { directory_requires_discovery: string }).directory_requires_discovery,
        (ruErrors as unknown as { directory_requires_discovery: string }).directory_requires_discovery],
    ];
    for (const [key, english, russian] of cases) {
      expect(english.toLowerCase(), key).toContain('discovery');
      expect(english.toLowerCase(), key).not.toContain('directory');
      expect(russian.toLowerCase(), key).toContain('обнаружени');
      expect(russian.toLowerCase(), key).not.toContain('каталог');
    }
  });
});
