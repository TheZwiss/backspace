#!/usr/bin/env node
/**
 * Localization consistency check. Runs in `pnpm typecheck` and before the
 * web build; the rules are documented in docs/systems/localization.md.
 *
 * Usage:
 *   node scripts/check-i18n.mjs                 report every finding, exit 1 if any
 *   node scripts/check-i18n.mjs --write-pending  rewrite scripts/i18n-pending.txt from
 *                                                the files that still carry literal
 *                                                strings, then report as usual
 *
 * The repository root is resolved from this file's location, so the command
 * behaves the same from the root and from a package directory.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PENDING_FILE,
  formatFinding,
  listLiteralStringFiles,
  runAllChecks,
  sortFindings,
} from './i18n/check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

if (args.has('--write-pending')) {
  const pending = listLiteralStringFiles(root);
  const header = [
    '# Source files not yet converted to the localization system.',
    '# The literal-string rule of scripts/check-i18n.mjs skips these; every other',
    '# rule still applies. Each sweep PR removes the files it converts, and the',
    '# list reaching zero is the definition of done for the first localized',
    '# release. Regenerate with: node scripts/check-i18n.mjs --write-pending',
  ];
  writeFileSync(path.join(root, PENDING_FILE), `${[...header, ...pending].join('\n')}\n`);
  console.log(`Wrote ${PENDING_FILE}: ${pending.length} file(s) pending.`);
}

const findings = sortFindings(runAllChecks(root));
for (const finding of findings) console.log(formatFinding(finding));

if (findings.length === 0) {
  console.log('i18n check: no findings.');
  process.exit(0);
}

const byRule = new Map();
for (const finding of findings) byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1);
const summary = [...byRule].map(([rule, count]) => `${rule} ${count}`).join(', ');
console.error(`i18n check: ${findings.length} finding(s) (${summary}).`);
process.exit(1);
