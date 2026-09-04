/**
 * The localization consistency check. Rules and rationale live in
 * docs/systems/localization.md ("Consistency check"). This module is pure:
 * every check takes a repository root and returns findings; the CLI in
 * scripts/check-i18n.mjs owns printing and the exit code.
 *
 * A finding is `{ rule, file, line?, message }` with `file` relative to the
 * root, using forward slashes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const SOURCE_LANGUAGE = 'en';
export const LOCALES_DIR = 'packages/web/src/locales';
export const WEB_SRC_DIR = 'packages/web/src';
export const FORMATTERS_FILE = 'packages/web/src/i18n/formatters.ts';
export const ERRORS_TS = 'packages/shared/src/errors.ts';
export const ALLOWLIST_FILE = 'scripts/i18n-allowlist.json';
export const PENDING_FILE = 'scripts/i18n-pending.txt';

const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

/** CLDR categories each shipped language must supply for a plural family. */
export const REQUIRED_PLURAL_FORMS = {
  en: ['one', 'other'],
  de: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'],
};
const DEFAULT_PLURAL_FORMS = ['one', 'other'];

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function readJson(abs) {
  return JSON.parse(readFileSync(abs, 'utf8'));
}

/** Recursively list files under `dir` (absolute), returning root-relative posix paths. */
function walk(root, dir, predicate, out = []) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = toPosix(path.join(dir, entry.name));
    if (entry.isDirectory()) walk(root, rel, predicate, out);
    else if (predicate(rel)) out.push(rel);
  }
  return out.sort();
}

function isTestFile(rel) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.includes('/test/') || rel.includes('/__tests__/');
}

function isSourceFile(rel) {
  return /\.[cm]?[jt]sx?$/.test(rel) && !rel.endsWith('.d.ts') && !isTestFile(rel);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

/** Flatten a nested catalog object into `{ 'a.b.c': 'value' }`. */
export function flattenCatalog(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenCatalog(value, full, out);
    else out[full] = value;
  }
  return out;
}

/** `storage.deleted_few` -> `{ base: 'storage.deleted', form: 'few' }`; a plain key has form null. */
export function splitPlural(key) {
  const match = PLURAL_SUFFIX_RE.exec(key);
  if (!match) return { base: key, form: null };
  return { base: key.slice(0, -match[0].length), form: match[1] };
}

/**
 * Load every `<lng>/<ns>.json` under the locales directory.
 *
 * Returns `{ languages, namespaces, catalogs }` where `catalogs[lng][ns]` is
 * the flattened catalog and `files[lng][ns]` its root-relative path.
 * `namespaces` is the set seen in the source language; other languages may
 * carry extra files, which the parity rule reports.
 */
export function loadCatalogs(root) {
  const localesAbs = path.join(root, LOCALES_DIR);
  const result = { languages: [], namespaces: [], catalogs: {}, files: {} };
  if (!existsSync(localesAbs)) return result;

  for (const entry of readdirSync(localesAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const lng = entry.name;
    result.languages.push(lng);
    result.catalogs[lng] = {};
    result.files[lng] = {};
    for (const file of readdirSync(path.join(localesAbs, lng))) {
      if (!file.endsWith('.json')) continue;
      const ns = file.slice(0, -'.json'.length);
      const rel = `${LOCALES_DIR}/${lng}/${file}`;
      result.catalogs[lng][ns] = flattenCatalog(readJson(path.join(root, rel)));
      result.files[lng][ns] = rel;
    }
  }
  result.languages.sort();
  result.namespaces = Object.keys(result.catalogs[SOURCE_LANGUAGE] ?? {}).sort();
  return result;
}

/** Group flattened keys into plural families: base -> { form|'' : value }. */
function families(flat) {
  const out = new Map();
  for (const [key, value] of Object.entries(flat)) {
    const { base, form } = splitPlural(key);
    if (!out.has(base)) out.set(base, new Map());
    out.get(base).set(form ?? '', value);
  }
  return out;
}

function isPluralFamily(family) {
  for (const form of family.keys()) if (form !== '') return true;
  return false;
}

function placeholdersOf(text) {
  const names = new Set();
  for (const match of String(text).matchAll(/\{\{\s*([^{}\s,]+)/g)) names.add(match[1]);
  return names;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function fileFor(loaded, lng, ns) {
  return loaded.files[lng]?.[ns] ?? `${LOCALES_DIR}/${lng}/${ns}.json`;
}

// ---------------------------------------------------------------------------
// Rule 1: parity
// ---------------------------------------------------------------------------

export function checkParity(root) {
  const loaded = loadCatalogs(root);
  const findings = [];
  const source = loaded.catalogs[SOURCE_LANGUAGE] ?? {};

  for (const lng of loaded.languages) {
    if (lng === SOURCE_LANGUAGE) continue;
    const target = loaded.catalogs[lng] ?? {};

    for (const ns of loaded.namespaces) {
      if (!target[ns]) {
        findings.push({ rule: 'parity', file: fileFor(loaded, lng, ns), message: `namespace "${ns}" is missing for ${lng}` });
        continue;
      }
      const sourceFamilies = families(source[ns]);
      const targetFamilies = families(target[ns]);
      for (const base of sourceFamilies.keys()) {
        if (!targetFamilies.has(base)) {
          findings.push({ rule: 'parity', file: fileFor(loaded, lng, ns), message: `key "${base}" exists in ${SOURCE_LANGUAGE} but not in ${lng}` });
        }
      }
      for (const base of targetFamilies.keys()) {
        if (!sourceFamilies.has(base)) {
          findings.push({ rule: 'parity', file: fileFor(loaded, lng, ns), message: `key "${base}" exists in ${lng} but not in ${SOURCE_LANGUAGE}` });
        }
      }
    }

    for (const ns of Object.keys(target)) {
      if (!source[ns]) {
        findings.push({ rule: 'parity', file: fileFor(loaded, lng, ns), message: `namespace "${ns}" exists for ${lng} but not for ${SOURCE_LANGUAGE}` });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 2: placeholders
// ---------------------------------------------------------------------------

export function checkPlaceholders(root) {
  const loaded = loadCatalogs(root);
  const findings = [];
  const source = loaded.catalogs[SOURCE_LANGUAGE] ?? {};

  for (const lng of loaded.languages) {
    if (lng === SOURCE_LANGUAGE) continue;
    for (const ns of loaded.namespaces) {
      const target = loaded.catalogs[lng]?.[ns];
      if (!target) continue;
      const sourceFamilies = families(source[ns]);
      const targetFamilies = families(target);
      for (const [base, sourceForms] of sourceFamilies) {
        const targetForms = targetFamilies.get(base);
        if (!targetForms) continue;
        const expected = new Set();
        for (const value of sourceForms.values()) for (const name of placeholdersOf(value)) expected.add(name);
        const actual = new Set();
        for (const value of targetForms.values()) for (const name of placeholdersOf(value)) actual.add(name);
        if (!sameSet(expected, actual)) {
          findings.push({
            rule: 'placeholders',
            file: fileFor(loaded, lng, ns),
            message: `key "${base}" uses {${[...actual].join(', ')}} in ${lng} but {${[...expected].join(', ')}} in ${SOURCE_LANGUAGE}`,
          });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 3: plural-forms
// ---------------------------------------------------------------------------

export function checkPluralForms(root) {
  const loaded = loadCatalogs(root);
  const findings = [];

  for (const ns of loaded.namespaces) {
    // A family is plural if any language gives it a suffix.
    const pluralBases = new Set();
    const perLanguage = new Map();
    for (const lng of loaded.languages) {
      const flat = loaded.catalogs[lng]?.[ns];
      if (!flat) continue;
      const fam = families(flat);
      perLanguage.set(lng, fam);
      for (const [base, forms] of fam) if (isPluralFamily(forms)) pluralBases.add(base);
    }

    for (const base of pluralBases) {
      for (const [lng, fam] of perLanguage) {
        const forms = fam.get(base);
        if (!forms) continue; // parity reports the missing family
        const required = REQUIRED_PLURAL_FORMS[lng] ?? DEFAULT_PLURAL_FORMS;
        const missing = required.filter((form) => !forms.has(form));
        const unexpected = [...forms.keys()].filter((form) => form !== '' && !PLURAL_SUFFIXES.includes(form));
        if (forms.has('')) {
          findings.push({ rule: 'plural-forms', file: fileFor(loaded, lng, ns), message: `key "${base}" mixes a plain value with plural forms in ${lng}` });
        }
        if (missing.length > 0) {
          findings.push({ rule: 'plural-forms', file: fileFor(loaded, lng, ns), message: `plural key "${base}" is missing _${missing.join(', _')} for ${lng}` });
        }
        if (unexpected.length > 0) {
          findings.push({ rule: 'plural-forms', file: fileFor(loaded, lng, ns), message: `plural key "${base}" has unknown form _${unexpected.join(', _')} in ${lng}` });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 4: count-without-plural
// ---------------------------------------------------------------------------

const USE_TRANSLATION_RE = /useTranslation\(\s*(?:\[\s*)?['"]([\w-]+)['"]/;
const T_CALL_RE = /\b(?:i18n\.)?t\(\s*(['"])([^'"\n]+)\1\s*,\s*\{([^}]*)\}/g;

function resolveKey(rawKey, defaultNs) {
  const colon = rawKey.indexOf(':');
  if (colon > 0) return { ns: rawKey.slice(0, colon), key: rawKey.slice(colon + 1) };
  return { ns: defaultNs, key: rawKey };
}

export function checkCountWithoutPlural(root) {
  const loaded = loadCatalogs(root);
  const source = loaded.catalogs[SOURCE_LANGUAGE] ?? {};
  const familiesByNs = new Map(Object.entries(source).map(([ns, flat]) => [ns, families(flat)]));
  const findings = [];

  for (const rel of walk(root, WEB_SRC_DIR, isSourceFile)) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    if (!text.includes('count')) continue;
    const defaultNs = USE_TRANSLATION_RE.exec(text)?.[1] ?? 'common';
    for (const match of text.matchAll(T_CALL_RE)) {
      if (!/\bcount\s*[:,}]/.test(match[3]) && !/\bcount\b\s*$/.test(match[3].trim())) continue;
      const { ns, key } = resolveKey(match[2], defaultNs);
      const fam = familiesByNs.get(ns)?.get(key);
      if (fam && isPluralFamily(fam)) continue;
      findings.push({
        rule: 'count-without-plural',
        file: rel,
        line: lineOf(text, match.index),
        message: `count passed to "${ns}:${key}", which has no plural forms in ${SOURCE_LANGUAGE}`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 5: untranslated
// ---------------------------------------------------------------------------

function loadAllowlist(root) {
  const abs = path.join(root, ALLOWLIST_FILE);
  if (!existsSync(abs)) return [];
  const data = readJson(abs);
  return Array.isArray(data) ? data : [];
}

/** True when the value has no letters once placeholders are removed. */
export function isPlaceholderOnly(value) {
  return !/\p{L}/u.test(String(value).replace(/\{\{[^{}]*\}\}/g, ''));
}

export function checkUntranslated(root, options = {}) {
  const loaded = loadCatalogs(root);
  const allow = new Set(options.allowlist ?? loadAllowlist(root));
  const findings = [];
  const source = loaded.catalogs[SOURCE_LANGUAGE] ?? {};

  for (const lng of loaded.languages) {
    if (lng === SOURCE_LANGUAGE) continue;
    for (const ns of loaded.namespaces) {
      const target = loaded.catalogs[lng]?.[ns];
      if (!target) continue;
      for (const [key, value] of Object.entries(target)) {
        const sourceValue = source[ns]?.[key];
        if (sourceValue === undefined || value !== sourceValue) continue;
        if (isPlaceholderOnly(value) || allow.has(value)) continue;
        findings.push({ rule: 'untranslated', file: fileFor(loaded, lng, ns), message: `key "${key}" is identical to ${SOURCE_LANGUAGE}: "${value}"` });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 6: direct-intl
// ---------------------------------------------------------------------------

const DIRECT_INTL_RE = /toLocaleDateString|toLocaleTimeString|toLocaleString|\bIntl\./g;

export function checkDirectIntl(root) {
  const findings = [];
  for (const rel of walk(root, WEB_SRC_DIR, isSourceFile)) {
    if (rel === FORMATTERS_FILE) continue;
    const text = readFileSync(path.join(root, rel), 'utf8');
    for (const match of text.matchAll(DIRECT_INTL_RE)) {
      findings.push({ rule: 'direct-intl', file: rel, line: lineOf(text, match.index), message: `${match[0]} outside ${FORMATTERS_FILE}` });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 7: error-code-missing
// ---------------------------------------------------------------------------

export function readErrorCodes(root) {
  const abs = path.join(root, ERRORS_TS);
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, 'utf8');
  const block = /ERROR_CODES\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (!block) return [];
  return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

export function checkErrorCodes(root) {
  const loaded = loadCatalogs(root);
  const errors = loaded.catalogs[SOURCE_LANGUAGE]?.errors;
  const file = fileFor(loaded, SOURCE_LANGUAGE, 'errors');
  const findings = [];
  if (!errors) {
    findings.push({ rule: 'error-code-missing', file, message: `no errors catalog for ${SOURCE_LANGUAGE}` });
    return findings;
  }
  if (typeof errors.generic !== 'string') {
    findings.push({ rule: 'error-code-missing', file, message: 'key "generic" is missing' });
  }
  for (const code of readErrorCodes(root)) {
    if (typeof errors[code] !== 'string') {
      findings.push({ rule: 'error-code-missing', file, message: `error code "${code}" has no entry` });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 8: literal-string
// ---------------------------------------------------------------------------

const ALLOW_LITERAL_MARKER = 'i18n-check: allow-literal';
const TEXT_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];

// A JSX tag whose attributes may contain `{...}` expressions nested two deep
// (enough for `onClick={() => set({ a: 1 })}`), followed by a text node that
// may itself contain `{...}` expressions, ending at the next tag.
const BRACES = String.raw`\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}`;
// A JSX tag is never glued to an identifier or a closing bracket the way a
// TypeScript generic is (`useRef<HTMLDivElement>(null)`), hence the lookbehind.
const TAG = String.raw`(?<![\w$.\])])<\/?[A-Za-z][\w.:-]*(?:\s+(?:[^<>{}]|${BRACES})*)?\/?>`;
const JSX_TEXT_RE = new RegExp(`(${TAG})((?:[^<>{}]|${BRACES})+?)(?=<)`, 'g');
// Text that is really JavaScript between two elements of a conditional:
// `</div>) : ready ? (<div>`. JSX text never starts with a closing bracket and
// never carries operators.
const JS_CONTEXT_RE = /^\s*[)\]}]|===|!==|&&|\|\||=>/;
const ATTRIBUTE_RE = new RegExp(String.raw`\b(${TEXT_ATTRIBUTES.join('|')})=(["'])([^"'\n]*?)\2`, 'g');
const TOAST_RE = /\baddToast\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

function stripExpressions(text) {
  let previous;
  let current = text;
  do {
    previous = current;
    current = current.replace(/\{[^{}]*\}/g, ' ');
  } while (current !== previous);
  return current;
}

function hasLetters(text) {
  return /\p{L}/u.test(text.replace(/&[a-zA-Z]+;|&#\d+;/g, ' '));
}

function stripComments(text) {
  // Block comments become spaces of equal length so indexes and lines hold.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

function allowedByMarker(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const previousLineStart = text.lastIndexOf('\n', lineStart - 2) + 1;
  const previousLine = text.slice(previousLineStart, Math.max(previousLineStart, lineStart - 1));
  const currentLine = text.slice(lineStart, text.indexOf('\n', index) === -1 ? text.length : text.indexOf('\n', index));
  return previousLine.includes(ALLOW_LITERAL_MARKER) || currentLine.includes(ALLOW_LITERAL_MARKER);
}

function literalFindingsIn(rel, rawText) {
  const findings = [];
  const text = rawText; // keep indexes; comments are consulted for the marker
  const scan = stripComments(rawText);
  const push = (index, message) => {
    if (allowedByMarker(text, index)) return;
    findings.push({ rule: 'literal-string', file: rel, line: lineOf(text, index), message });
  };

  for (const match of scan.matchAll(JSX_TEXT_RE)) {
    const tag = match[1];
    const body = match[2];
    if (/^<\/?(?:script|style)\b/.test(tag)) continue;
    const visible = stripExpressions(body).trim();
    if (!hasLetters(visible) || JS_CONTEXT_RE.test(visible)) continue;
    const bodyIndex = match.index + tag.length + body.search(/\S/);
    push(bodyIndex, `JSX text "${visible.replace(/\s+/g, ' ').slice(0, 60)}"`);
  }

  for (const match of scan.matchAll(ATTRIBUTE_RE)) {
    if (!hasLetters(match[3])) continue;
    push(match.index, `${match[1]} attribute "${match[3].slice(0, 60)}"`);
  }

  for (const match of scan.matchAll(TOAST_RE)) {
    if (!hasLetters(match[2])) continue;
    push(match.index, `addToast literal "${match[2].slice(0, 60)}"`);
  }

  return findings;
}

function loadPending(root) {
  const abs = path.join(root, PENDING_FILE);
  if (!existsSync(abs)) return [];
  return readFileSync(abs, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function isComponentFile(rel) {
  return rel.endsWith('.tsx') && !isTestFile(rel);
}

export function checkLiteralStrings(root, options = {}) {
  const pending = new Set(options.pending ?? loadPending(root));
  const findings = [];
  for (const rel of walk(root, WEB_SRC_DIR, isComponentFile)) {
    if (pending.has(rel)) continue;
    findings.push(...literalFindingsIn(rel, readFileSync(path.join(root, rel), 'utf8')));
  }
  return findings;
}

/** Every component file that still has literal strings, ignoring the pending list. */
export function listLiteralStringFiles(root) {
  const files = [];
  for (const rel of walk(root, WEB_SRC_DIR, isComponentFile)) {
    if (literalFindingsIn(rel, readFileSync(path.join(root, rel), 'utf8')).length > 0) files.push(rel);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Rule 9: markup
// ---------------------------------------------------------------------------

// html-parse-stringify (used by react-i18next's Trans component) parses these
// as HTML void elements. They cannot be used as wrappers for React components:
// `<link>text</link>`, for example, renders an empty <link> and leaves `text`
// outside the component supplied to Trans.
const HTML_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const MARKUP_TAG_RE = /<\/?([A-Za-z][\w-]*)\b[^>]*>/g;

function markupTagsOf(value) {
  const tags = new Set();
  for (const match of String(value).matchAll(MARKUP_TAG_RE)) tags.add(match[1]);
  return tags;
}

function pairedVoidTagsOf(value) {
  const text = String(value);
  const opening = new Set();
  const closing = new Set();
  for (const match of text.matchAll(MARKUP_TAG_RE)) {
    const full = match[0];
    // html-parse-stringify deliberately keeps this lookup case-sensitive, so
    // `<Link>` is a valid component name while lowercase `<link>` is void.
    const tag = match[1];
    if (!HTML_VOID_TAGS.has(tag)) continue;
    if (full.startsWith('</')) closing.add(tag);
    else if (!full.endsWith('/>')) opening.add(tag);
  }
  return new Set([...opening].filter((tag) => closing.has(tag)));
}

export function checkMarkup(root) {
  const loaded = loadCatalogs(root);
  const findings = [];
  const source = loaded.catalogs[SOURCE_LANGUAGE] ?? {};

  // Validate every catalog, including English: unsafe markup in the source is
  // just as capable of breaking a Trans component as a translator's change.
  for (const lng of loaded.languages) {
    for (const [ns, flat] of Object.entries(loaded.catalogs[lng] ?? {})) {
      for (const [key, value] of Object.entries(flat)) {
        for (const tag of pairedVoidTagsOf(value)) {
          findings.push({
            rule: 'markup',
            file: fileFor(loaded, lng, ns),
            message: `key "${key}" uses HTML void tag <${tag}> as a wrapper; use a non-HTML Trans component name`,
          });
        }
      }
    }
  }

  // As with interpolation placeholders, markup is part of a translation's
  // contract. Compare the union across plural forms because CLDR categories
  // differ between languages.
  for (const lng of loaded.languages) {
    if (lng === SOURCE_LANGUAGE) continue;
    for (const ns of loaded.namespaces) {
      const target = loaded.catalogs[lng]?.[ns];
      if (!target) continue;
      const sourceFamilies = families(source[ns]);
      const targetFamilies = families(target);
      for (const [base, sourceForms] of sourceFamilies) {
        const targetForms = targetFamilies.get(base);
        if (!targetForms) continue;
        const expected = new Set();
        for (const value of sourceForms.values()) for (const tag of markupTagsOf(value)) expected.add(tag);
        const actual = new Set();
        for (const value of targetForms.values()) for (const tag of markupTagsOf(value)) actual.add(tag);
        if (!sameSet(expected, actual)) {
          findings.push({
            rule: 'markup',
            file: fileFor(loaded, lng, ns),
            message: `key "${base}" uses <${[...actual].join('>, <')}> in ${lng} but <${[...expected].join('>, <')}> in ${SOURCE_LANGUAGE}`,
          });
        }
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// All together
// ---------------------------------------------------------------------------

export const RULES = [
  'parity',
  'placeholders',
  'plural-forms',
  'count-without-plural',
  'untranslated',
  'direct-intl',
  'error-code-missing',
  'literal-string',
  'markup',
];

export function runAllChecks(root, options = {}) {
  return [
    ...checkParity(root),
    ...checkPlaceholders(root),
    ...checkPluralForms(root),
    ...checkCountWithoutPlural(root),
    ...checkUntranslated(root, options),
    ...checkDirectIntl(root),
    ...checkErrorCodes(root),
    ...checkLiteralStrings(root, options),
    ...checkMarkup(root),
  ];
}

export function formatFinding(finding) {
  const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
  return `${where} ${finding.rule}: ${finding.message}`;
}

export function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}

export function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
