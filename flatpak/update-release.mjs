#!/usr/bin/env node

// Points the Flatpak metadata at a release: the manifest's source pin, the
// screenshot URLs' tag, and a new AppStream release entry whose description is
// the store-facing "What's New" text (see release-summary.mjs for where that
// text comes from).
//
// node flatpak/update-release.mjs <tag> <commit> <date> <description>

import { readFileSync, writeFileSync } from 'node:fs';

const [tag, commit, date, description] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
  throw new Error(`Expected a release tag such as v1.0.5, got ${tag ?? '<missing>'}`);
}
if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
  throw new Error('Expected the full 40-character release commit SHA');
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  throw new Error('Expected the release date in YYYY-MM-DD form');
}
if (typeof description !== 'string' || description.trim() === '') {
  throw new Error('Expected the release description (the "What\'s New" text) as the fourth argument');
}
if (/[\r\n]/.test(description)) {
  throw new Error('Expected the release description on a single line');
}

const version = tag.slice(1);
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
if (rootPackage.version !== version) {
  throw new Error(`Tag ${tag} does not match package.json version ${rootPackage.version}`);
}

/** Escapes the characters that are markup in AppStream's XML text content. */
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const manifestPath = 'io.github.TheZwiss.backspace.yml';
const manifest = readFileSync(manifestPath, 'utf8');
const pinPattern = /(        commit: )[0-9a-f]{40}/;
if (!pinPattern.test(manifest)) throw new Error('Flatpak manifest commit pin not found');

const metainfoPath = 'flatpak/io.github.TheZwiss.backspace.metainfo.xml';
let metainfo = readFileSync(metainfoPath, 'utf8');
metainfo = metainfo.replace(
  /https:\/\/raw\.githubusercontent\.com\/TheZwiss\/backspace\/v\d+\.\d+\.\d+\/docs\/screenshots\//g,
  `https://raw.githubusercontent.com/TheZwiss/backspace/${tag}/docs/screenshots/`,
);

// The workflow runs this on the tag's files, so an entry for this version here
// was committed before the tag was cut, by hand; it is never replaced.
if (metainfo.includes(`<release version="${version}"`)) {
  console.log(`AppStream already has a release entry for ${version}; leaving it untouched.`);
} else {
  const marker = '  <releases>\n';
  if (!metainfo.includes(marker)) throw new Error('AppStream releases block not found');
  const release = [
    `    <release version="${version}" date="${date}">`,
    '      <description>',
    `        <p>${escapeXml(description.trim())}</p>`,
    '      </description>',
    '    </release>',
    '',
  ].join('\n');
  metainfo = metainfo.replace(marker, marker + release);
}

writeFileSync(manifestPath, manifest.replace(pinPattern, `$1${commit}`));
writeFileSync(metainfoPath, metainfo);
