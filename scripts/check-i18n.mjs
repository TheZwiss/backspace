import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '../packages/web/node_modules/typescript/lib/typescript.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(repoRoot, 'packages/web/src');
const en = JSON.parse(fs.readFileSync(path.join(webRoot, 'locales/en/translation.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(webRoot, 'locales/ru/translation.json'), 'utf8'));
const errors = [];
const allowedUntranslated = new Set([
  'Backspace', 'DMs', 'LIVE', '.tus/', 'NVIDIA / Apple', 'https://instance.example.com',
]);

function placeholders(value) {
  return [...value.matchAll(/\{\{[^}]+\}\}|<\/?\w+[^>]*>/g)].map(([match]) => match).sort();
}

function compareCatalogs(english, russian, prefix = '') {
  for (const key of new Set([...Object.keys(english), ...Object.keys(russian)])) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (!(key in english)) errors.push(`Russian-only catalog key: ${current}`);
    else if (!(key in russian)) errors.push(`Missing Russian catalog key: ${current}`);
    else if (typeof english[key] === 'object' && english[key] !== null) {
      if (typeof russian[key] !== 'object' || russian[key] === null) errors.push(`Catalog type mismatch: ${current}`);
      else compareCatalogs(english[key], russian[key], current);
    } else if (typeof english[key] !== typeof russian[key]) {
      errors.push(`Catalog type mismatch: ${current}`);
    } else if (typeof english[key] === 'string') {
      if (english[key] === russian[key] && /[A-Za-z]{3}/.test(english[key]) && !allowedUntranslated.has(english[key])) {
        errors.push(`Untranslated Russian value: ${current}`);
      }
      if (JSON.stringify(placeholders(english[key])) !== JSON.stringify(placeholders(russian[key]))) {
        errors.push(`Placeholder mismatch: ${current}`);
      }
    }
  }
}
compareCatalogs(en, ru);

const attributeNames = new Set([
  'title', 'aria-label', 'placeholder', 'alt', 'label', 'description',
  'confirmLabel', 'cancelLabel', 'content',
]);
const messageCalls = new Set(['addToast', 'setError', 'setStatusMessage', 'setMessage', 'sendNotification']);

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'locales' || entry.name === 'test' ? [] : filesUnder(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

function hasEnglish(value) {
  return !/^&\w+;$/.test(value.trim())
    && /[A-Za-z]{2,}/.test(value)
    && !/^(https?:|\/|#|@|[a-z]+_[a-z_]+$)/i.test(value)
    && !/^(auth|common|runtime|settings|language|mobile|ui)\./.test(value)
    && !/\b(bg-|text-|flex|grid|rounded|opacity|cursor|transition|translate-|scale|object-|items-|justify-|border-|w-|h-|p-|m-)\b/.test(value);
}

for (const file of filesUnder(webRoot)) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const relative = path.relative(repoRoot, file);
  const report = (node, kind, value) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    errors.push(`${relative}:${line}: ${kind}: ${JSON.stringify(value.trim())}`);
  };

  function visit(node) {
    if (ts.isJsxText(node) && hasEnglish(node.text.trim())) {
      let parent = node.parent;
      let insideTrans = false;
      while (parent && !ts.isSourceFile(parent)) {
        if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(sourceFile) === 'Trans') insideTrans = true;
        parent = parent.parent;
      }
      if (!insideTrans) report(node, 'untranslated JSX text', node.text);
    }
    if (ts.isJsxAttribute(node) && attributeNames.has(node.name.getText(sourceFile)) && node.initializer && ts.isStringLiteral(node.initializer) && hasEnglish(node.initializer.text)) {
      report(node, 'untranslated JSX attribute', node.initializer.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const name = node.expression.getText(sourceFile).split('.').at(-1);
      const first = node.arguments[0];
      if (name && (messageCalls.has(name) || /^set[A-Za-z]*Error$/.test(name)) && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && hasEnglish(first.text)) {
        report(first, 'untranslated UI message', first.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

if (errors.length > 0) {
  console.error(`i18n check failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('i18n catalogs and UI string coverage are valid.');
