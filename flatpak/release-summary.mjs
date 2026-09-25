#!/usr/bin/env node

// Extracts the store-facing "What's New" text for a release from its GitHub
// release notes. The notes open with "# Backspace X.Y.Z", a blank line, and a
// one-paragraph summary; that paragraph becomes the AppStream release
// description shown by GNOME Software, KDE Discover and Flathub.
//
// Anything that is not that shape is an error rather than a fallback: the
// release metadata job fails instead of shipping a placeholder or a stray
// heading, table or list as the release description.
//
// Command line: node flatpak/release-summary.mjs <version> < notes.md
// prints the summary on stdout, or the reason on stderr with exit status 1.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HINT = 'Write the summary as one plain paragraph directly under the title; it becomes the Flatpak "What\'s New" text.';

// A line that opens a new Markdown block even without a blank line before it:
// an ATX heading, a bullet list item, or a table row.
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:\s|$)|[-*+]\s|\|)/;

// Characters in the Unicode private-use area never occur in release notes, so
// they can stand in for inline code while the rest of the text is rewritten.
const CODE_OPEN = '';
const CODE_CLOSE = '';

/**
 * @param {string} body The release notes, as `gh release view --json body` returns them.
 * @param {string} version The release version without the leading "v", such as "1.5.2".
 * @returns {string} The summary paragraph as plain text on one line.
 */
export function releaseSummary(body, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`Expected a version such as 1.5.2, got ${version ?? '<missing>'}`);
  }
  const title = `# Backspace ${version}`;
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');

  let index = lines.findIndex(line => line.trim() !== '');
  if (index === -1) {
    throw new Error(`Release notes have no "${title}" heading: the body is empty. ${HINT}`);
  }
  const first = lines[index].trim();
  if (first !== title) {
    throw new Error(`Expected the release notes' first line to be "${title}", found "${first}". ${HINT}`);
  }

  index += 1;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (index === lines.length) {
    throw new Error(`Release notes for ${version} have no summary paragraph under "${title}". ${HINT}`);
  }

  const paragraph = [lines[index].trim()];
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || BLOCK_START.test(line)) break;
    paragraph.push(line.trim());
  }

  const lead = paragraph[0][0];
  if ('#|-*'.includes(lead)) {
    throw new Error(
      `The first paragraph of the ${version} release notes starts with "${lead}", `
      + `so it is a heading, table or list rather than the summary. ${HINT}`,
    );
  }

  const text = toPlainText(paragraph.join(' '));
  if (text === '') {
    throw new Error(`The first paragraph of the ${version} release notes is empty once its Markdown is removed. ${HINT}`);
  }
  return text;
}

/** Reduces inline Markdown to the text a reader sees. */
function toPlainText(markdown) {
  const code = [];
  let text = markdown.replace(/`([^`]+)`/g, (_, content) => {
    code.push(content);
    return `${CODE_OPEN}${code.length - 1}${CODE_CLOSE}`;
  });

  // [text](url), allowing one level of parentheses inside the URL.
  text = text.replace(/\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, '$1');
  // Strong emphasis first so its markers are not read as two single ones.
  text = text.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1');
  text = text.replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '$1');
  text = text.replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1');
  text = text.replace(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1');

  text = text.replace(new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g'), (_, i) => code[Number(i)]);
  return text.replace(/\s+/g, ' ').trim();
}

function runCli() {
  const version = process.argv[2];
  try {
    process.stdout.write(`${releaseSummary(readFileSync(0, 'utf8'), version)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
