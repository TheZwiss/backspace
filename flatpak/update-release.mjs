#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

const [tag, commit, date] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
  throw new Error(`Expected a release tag such as v1.0.5, got ${tag ?? '<missing>'}`);
}
if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
  throw new Error('Expected the full 40-character release commit SHA');
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  throw new Error('Expected the release date in YYYY-MM-DD form');
}

const version = tag.slice(1);
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
if (rootPackage.version !== version) {
  throw new Error(`Tag ${tag} does not match package.json version ${rootPackage.version}`);
}

const manifestPath = 'io.github.TheZwiss.backspace.yml';
const manifest = readFileSync(manifestPath, 'utf8');
const pinPattern = /(        commit: )[0-9a-f]{40}/;
if (!pinPattern.test(manifest)) throw new Error('Flatpak manifest commit pin not found');
writeFileSync(manifestPath, manifest.replace(pinPattern, `$1${commit}`));

const metainfoPath = 'flatpak/io.github.TheZwiss.backspace.metainfo.xml';
let metainfo = readFileSync(metainfoPath, 'utf8');
metainfo = metainfo.replace(
  /https:\/\/raw\.githubusercontent\.com\/TheZwiss\/backspace\/v\d+\.\d+\.\d+\/docs\/screenshots\//g,
  `https://raw.githubusercontent.com/TheZwiss/backspace/${tag}/docs/screenshots/`,
);

if (!metainfo.includes(`<release version="${version}"`)) {
  const marker = '  <releases>\n';
  if (!metainfo.includes(marker)) throw new Error('AppStream releases block not found');
  const release = [
    `    <release version="${version}" date="${date}">`,
    '      <description>',
    `        <p>Backspace ${version} release.</p>`,
    '      </description>',
    '    </release>',
    '',
  ].join('\n');
  metainfo = metainfo.replace(marker, marker + release);
}
writeFileSync(metainfoPath, metainfo);
