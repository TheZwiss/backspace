import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkParity,
  checkPlaceholders,
  checkPluralForms,
  checkCountWithoutPlural,
  checkUntranslated,
  checkDirectIntl,
  checkErrorCodes,
  checkLiteralStrings,
  listLiteralStringFiles,
  runAllChecks,
} from '../../../../scripts/i18n/check.mjs';

type Finding = { rule: string; file: string; line?: number; message: string };

/** Build a throwaway repo root with the layout the checks expect. */
function makeRoot(files: Record<string, string | object>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'i18n-check-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return root;
}

const locale = (lng: string, ns: string) => `packages/web/src/locales/${lng}/${ns}.json`;

describe('parity', () => {
  it('reports a key missing from a language and a key only in a language', () => {
    const root = makeRoot({
      [locale('en', 'common')]: { a: 'A', b: 'B' },
      [locale('ru', 'common')]: { a: 'А', c: 'В' },
    });
    const findings = checkParity(root) as Finding[];
    expect(findings.map((f) => f.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('b'),
      expect.stringContaining('c'),
    ]));
    expect(findings.every((f) => f.rule === 'parity')).toBe(true);
  });

  it('treats plural forms as one key family', () => {
    const root = makeRoot({
      [locale('en', 'common')]: { files_one: '{{count}} file', files_other: '{{count}} files' },
      [locale('ru', 'common')]: { files_one: 'a', files_few: 'b', files_many: 'c', files_other: 'd' },
    });
    expect(checkParity(root)).toEqual([]);
  });

  it('reports a namespace file missing from a language', () => {
    const root = makeRoot({
      [locale('en', 'common')]: { a: 'A' },
      [locale('en', 'errors')]: { generic: 'x' },
      [locale('ru', 'common')]: { a: 'А' },
    });
    const findings = checkParity(root) as Finding[];
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('errors');
  });
});

describe('placeholders', () => {
  it('reports a placeholder set that differs between languages', () => {
    const root = makeRoot({
      [locale('en', 'common')]: { greet: 'Hi {{name}}' },
      [locale('de', 'common')]: { greet: 'Hallo {{nam}}' },
    });
    const findings = checkPlaceholders(root) as Finding[];
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('placeholders');
    expect(findings[0]!.message).toContain('greet');
  });

  it('compares the union of forms for a plural family', () => {
    const root = makeRoot({
      [locale('en', 'common')]: { n_one: 'one {{count}}', n_other: '{{count}} things' },
      [locale('ru', 'common')]: { n_one: '{{count}} а', n_few: '{{count}} б', n_many: '{{count}} в', n_other: '{{count}} г' },
    });
    expect(checkPlaceholders(root)).toEqual([]);
  });
});

describe('plural-forms', () => {
  it('reports a Russian family without the few and many forms', () => {
    const root = makeRoot({
      [locale('en', 'common')]: { n_one: 'a', n_other: 'b' },
      [locale('ru', 'common')]: { n_one: 'а', n_other: 'б' },
    });
    const findings = checkPluralForms(root) as Finding[];
    expect(findings.map((f) => f.message).join(' ')).toMatch(/few/);
    expect(findings.map((f) => f.message).join(' ')).toMatch(/many/);
    expect(findings.every((f) => f.rule === 'plural-forms')).toBe(true);
  });

  it('passes when every language has its categories', () => {
    const root = makeRoot({
      [locale('en', 'common')]: { n_one: 'a', n_other: 'b' },
      [locale('de', 'common')]: { n_one: 'a', n_other: 'b' },
      [locale('ru', 'common')]: { n_one: 'а', n_few: 'б', n_many: 'в', n_other: 'г' },
    });
    expect(checkPluralForms(root)).toEqual([]);
  });
});

describe('count-without-plural', () => {
  it('reports count passed to a key that has no plural family', () => {
    const root = makeRoot({
      [locale('en', 'settings')]: { storage: { deleted: 'Deleted {{count}} files' } },
      'packages/web/src/components/A.tsx': [
        "import { useTranslation } from 'react-i18next';",
        "export function A() { const { t } = useTranslation('settings');",
        "return <p>{t('storage.deleted', { count: 3 })}</p>; }",
      ].join('\n'),
    });
    const findings = checkCountWithoutPlural(root) as Finding[];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'count-without-plural', file: 'packages/web/src/components/A.tsx', line: 3 });
  });

  it('passes when the key is a plural family, including with an explicit namespace prefix', () => {
    const root = makeRoot({
      [locale('en', 'settings')]: { storage: { deleted_one: 'x', deleted_other: 'y' } },
      [locale('en', 'common')]: { items_one: 'x', items_other: 'y' },
      'packages/web/src/components/A.tsx': [
        "const { t } = useTranslation(['settings', 'common']);",
        "t('storage.deleted', { count: n });",
        "i18n.t('common:items', { count: n });",
      ].join('\n'),
    });
    expect(checkCountWithoutPlural(root)).toEqual([]);
  });
});

describe('untranslated', () => {
  it('reports a value identical to English', () => {
    const root = makeRoot({
      [locale('en', 'common')]: { save: 'Save' },
      [locale('de', 'common')]: { save: 'Save' },
    });
    const findings = checkUntranslated(root, { allowlist: [] }) as Finding[];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'untranslated', file: locale('de', 'common') });
  });

  it('allows placeholder-only values and allowlisted words', () => {
    const root = makeRoot({
      [locale('en', 'common')]: { counter: '{{used}}/{{max}}', hex: '#hex', brand: 'Backspace', ok: 'OK' },
      [locale('de', 'common')]: { counter: '{{used}}/{{max}}', hex: '#hex', brand: 'Backspace', ok: 'OK' },
    });
    expect(checkUntranslated(root, { allowlist: ['Backspace', 'OK', '#hex'] })).toEqual([]);
  });

  it('reads the allowlist file from the root when no list is given', () => {
    const root = makeRoot({
      [locale('en', 'common')]: { brand: 'Backspace' },
      [locale('de', 'common')]: { brand: 'Backspace' },
      'scripts/i18n-allowlist.json': ['Backspace'],
    });
    expect(checkUntranslated(root)).toEqual([]);
  });
});

describe('direct-intl', () => {
  it('reports toLocale* and Intl.* outside the formatters module and outside tests', () => {
    const root = makeRoot({
      'packages/web/src/components/M.tsx': "const s = new Date(t).toLocaleDateString();\nconst n = new Intl.NumberFormat('en');",
      'packages/web/src/i18n/formatters.ts': "new Intl.DateTimeFormat('en');",
      'packages/web/src/i18n/formatters.test.ts': "d.toLocaleString();",
    });
    const findings = checkDirectIntl(root) as Finding[];
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line).sort()).toEqual([1, 2]);
    expect(findings.every((f) => f.file === 'packages/web/src/components/M.tsx')).toBe(true);
  });
});

describe('error-code-missing', () => {
  const errorsTs = "export const ERROR_CODES = [\n  'not_found',\n  'recipient_deleted',\n] as const;\n";

  it('reports a shared code with no English entry, and a missing generic key', () => {
    const root = makeRoot({
      'packages/shared/src/errors.ts': errorsTs,
      [locale('en', 'errors')]: { not_found: 'x' },
    });
    const findings = checkErrorCodes(root) as Finding[];
    expect(findings.map((f) => f.message).join(' ')).toMatch(/recipient_deleted/);
    expect(findings.map((f) => f.message).join(' ')).toMatch(/generic/);
    expect(findings.every((f) => f.rule === 'error-code-missing')).toBe(true);
  });

  it('passes when every code and generic have entries', () => {
    const root = makeRoot({
      'packages/shared/src/errors.ts': errorsTs,
      [locale('en', 'errors')]: { generic: 'g', not_found: 'x', recipient_deleted: 'y' },
    });
    expect(checkErrorCodes(root)).toEqual([]);
  });
});

describe('literal-string', () => {
  const dirty = [
    'export function P({ n }: { n: number }) {',
    '  const addToast = (m: string) => m;',
    '  return (',
    '    <div title="Hover me">',
    '      <button onClick={() => addToast("Saved")}>Save changes</button>',
    '      <input placeholder="Type here" />',
    '      <span>{n}/190</span>',
    '      <span>@{n}</span>',
    '      <b>&amp;</b>',
    '      {/* i18n-check: allow-literal */}',
    '      <code>RNNoise</code>',
    '    </div>',
    '  );',
    '}',
  ].join('\n');

  it('reports JSX text, attribute strings and toast literals, honouring the allow comment', () => {
    const root = makeRoot({ 'packages/web/src/components/P.tsx': dirty });
    const findings = checkLiteralStrings(root, { pending: [] }) as Finding[];
    const lines = findings.map((f) => f.line).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(lines).toEqual([4, 5, 5, 6]);
    expect(findings.every((f) => f.rule === 'literal-string')).toBe(true);
  });

  it('skips files on the pending list and test files', () => {
    const root = makeRoot({
      'packages/web/src/components/P.tsx': dirty,
      'packages/web/src/components/P.test.tsx': dirty,
    });
    expect(checkLiteralStrings(root, { pending: ['packages/web/src/components/P.tsx'] })).toEqual([]);
  });

  it('reads the pending list from the root when none is given', () => {
    const root = makeRoot({
      'packages/web/src/components/P.tsx': dirty,
      'scripts/i18n-pending.txt': '# files not yet swept\npackages/web/src/components/P.tsx\n',
    });
    expect(checkLiteralStrings(root)).toEqual([]);
  });

  it('passes a converted component', () => {
    const clean = [
      "const { t } = useTranslation('settings');",
      'const ref = useRef<HTMLDivElement>(null); const [n, setN] = useState<number | null>(null);',
      'const list = useMemo<Array<string>>(() => [], []);',
      'return (',
      '  <div title={t("a")}>',
      '    <button onClick={() => addToast(t("b"), "success")}>{t("c")}</button>',
      '    <input placeholder={t("d")} className="input-standard w-full" />',
      '    <span className="text-xs">{bio.length}/{max}</span>',
      '    <span>⚠</span>',
      '    <span> {user.name} </span>',
      '    {ready ? (',
      '      <div>{t("e")}</div>',
      "    ) : permState === 'granted' && !supportsSinkId ? (",
      '      <div>{t("f")}</div>',
      '    ) : null}',
      '  </div>',
      ');',
    ].join('\n');
    const root = makeRoot({ 'packages/web/src/components/C.tsx': clean });
    expect(checkLiteralStrings(root, { pending: [] })).toEqual([]);
  });

  it('lists every file with literals regardless of the pending list', () => {
    const root = makeRoot({
      'packages/web/src/components/P.tsx': dirty,
      'packages/web/src/components/Q.tsx': 'const x = 1;',
    });
    expect(listLiteralStringFiles(root)).toEqual(['packages/web/src/components/P.tsx']);
  });
});

describe('runAllChecks', () => {
  it('returns findings from every rule against one root', () => {
    const root = makeRoot({
      'packages/shared/src/errors.ts': "export const ERROR_CODES = ['x'] as const;",
      [locale('en', 'errors')]: { generic: 'g', x: 'X' },
      [locale('de', 'errors')]: { generic: 'h', x: 'Y' },
      [locale('en', 'common')]: { a: 'A' },
      [locale('de', 'common')]: { a: 'A' },
      'packages/web/src/components/M.tsx': 'const s = d.toLocaleString();',
    });
    const findings = runAllChecks(root, { allowlist: [], pending: [] }) as Finding[];
    expect(new Set(findings.map((f) => f.rule))).toEqual(new Set(['untranslated', 'direct-intl']));
  });
});
