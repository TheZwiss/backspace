#!/usr/bin/env node

// The Node SDK extension appears in files flatpak-builder never reads: the
// workflows install it and pass it to flatpak-node-generator, and the README
// and prepare-ci-manifest.mjs show the same commands. Every such reference has
// to name an extension the manifest lists in sdk-extensions, on the branch
// that matches the manifest's runtime-version, or the generated offline
// sources target an SDK the build does not use. This checks that they agree.
//
// Command line: node flatpak/node-sdk-version.mjs checks the files below from
// the checkout this script is in, prints the reference it expects and exits 0,
// or prints each disagreement as path:line on stderr and exits 1.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Files that reference the Node SDK extension. `generator` marks the ones that must pass --node-sdk-extension. */
export const REFERENCING_FILES = [
  { path: '.github/workflows/flatpak.yml', generator: true },
  { path: '.github/workflows/flatpak-release-metadata.yml', generator: true },
  { path: 'flatpak/README.md', generator: false },
  { path: 'flatpak/prepare-ci-manifest.mjs', generator: false },
];

const MANIFEST = 'io.github.TheZwiss.backspace.yml';
const EXTENSION_REFERENCE = /(org\.freedesktop\.Sdk\.Extension\.[A-Za-z0-9_]+)\/\/([^\s'"`\\]+)/g;
const GENERATOR_FLAG = /--node-sdk-extension[ =](\S+)/g;
const FULL_REFERENCE = /^org\.freedesktop\.Sdk\.Extension\.[A-Za-z0-9_]+\/\/[^\s'"`\\]+$/;

function readRuntimeVersion(manifest) {
  const match = /^runtime-version:[ \t]*(['"]?)([^'"\s#]+)\1[ \t]*(?:#.*)?\r?$/m.exec(manifest);
  if (!match) {
    throw new Error('The Flatpak manifest has no runtime-version');
  }
  return match[2];
}

function readSdkExtensions(manifest) {
  const block = /^sdk-extensions:[ \t]*\r?\n((?:[ \t]+-[ \t]+\S+[ \t]*(?:\r?\n|$))+)/m.exec(manifest);
  if (!block) {
    throw new Error('The Flatpak manifest has no sdk-extensions list');
  }
  return block[1].split(/\r?\n/).map((line) => line.replace(/^[ \t]+-[ \t]+/, '').trim()).filter(Boolean);
}

/**
 * @param {string} manifest The Flatpak manifest's text.
 * @param {{ path: string, text: string, generator: boolean }[]} files The files to check.
 * @returns {string[]} One `path:line: reason` entry per disagreement; empty when all agree.
 */
export function checkNodeSdkExtension(manifest, files) {
  const runtimeVersion = readRuntimeVersion(manifest);
  const extensions = readSdkExtensions(manifest);
  const problems = [];

  for (const { path, text, generator } of files) {
    let flags = 0;
    text.split(/\r?\n/).forEach((line, index) => {
      const where = `${path}:${index + 1}`;
      for (const [, value] of line.matchAll(GENERATOR_FLAG)) {
        flags += 1;
        if (!FULL_REFERENCE.test(value)) {
          problems.push(`${where}: --node-sdk-extension is given ${value}, expected <extension>//${runtimeVersion}`);
        }
      }
      for (const [reference, extension, branch] of line.matchAll(EXTENSION_REFERENCE)) {
        if (!extensions.includes(extension)) {
          problems.push(`${where}: ${reference}: ${extension} is not in the manifest's sdk-extensions (${extensions.join(', ')})`);
        } else if (branch !== runtimeVersion) {
          problems.push(`${where}: ${reference} does not match the manifest's runtime-version '${runtimeVersion}'`);
        }
      }
    });
    if (generator && flags === 0) {
      problems.push(`${path}: no --node-sdk-extension flag found`);
    }
  }
  return problems;
}

function runCli() {
  const root = new URL('../', import.meta.url);
  const read = (path) => readFileSync(new URL(path, root), 'utf8');
  try {
    const manifest = read(MANIFEST);
    const problems = checkNodeSdkExtension(
      manifest,
      REFERENCING_FILES.map(({ path, generator }) => ({ path, text: read(path), generator })),
    );
    if (problems.length > 0) {
      process.stderr.write(`The Node SDK extension disagrees with ${MANIFEST}:\n${problems.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    const expected = readSdkExtensions(manifest).map((extension) => `${extension}//${readRuntimeVersion(manifest)}`);
    process.stdout.write(`Every reference names ${expected.join(' or ')}, as ${MANIFEST} does.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
