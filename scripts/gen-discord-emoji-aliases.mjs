#!/usr/bin/env node
/**
 * Generates packages/web/src/utils/discordEmojiAliases.ts: the Discord emoji
 * shortcode names that the emoji picker's own names (emoji-mart) do not
 * already resolve, so text written for Discord (`:cross:`, `:slight_smile:`,
 * `:regional_indicator_a:`) renders as the emoji it names.
 *
 * Usage:
 *   node scripts/gen-discord-emoji-aliases.mjs                 fetch the source, write the table
 *   node scripts/gen-discord-emoji-aliases.mjs --source <file>  use a saved copy of the source
 *
 * Source: Emzi0767's Discord Emoji Map, the emoji definitions extracted from
 * the stable Discord web client (https://mzgit.dev/Emzi0767/discord-emoji).
 * The URL always serves the latest extraction, so the generated file records
 * the map's `version` and `versionTimestamp`; the committed table is the pin.
 *
 * What goes into the table:
 *   - every Discord name that does not resolve through emoji-mart, where `_`
 *     and `-` are the same character (the rule in emojiShortcodes.ts).
 *     emoji-mart names always win: a Discord name that is also an emoji-mart
 *     name is left out even when the two sets disagree on the emoji.
 *   - skin tones are not listed one by one. The renderer applies Discord's
 *     two tone spellings to any base name: `_tone1`..`_tone5` and
 *     `_light_skin_tone`, `_medium_light_skin_tone`, `_medium_skin_tone`,
 *     `_medium_dark_skin_tone`, `_dark_skin_tone` (tone 1 is the lightest,
 *     U+1F3FB, which is emoji-mart's skin index 1). This script checks every
 *     toned Discord name against that rule and lists only the ones the rule
 *     would get wrong, under their `_toneN` spelling (the renderer reads the
 *     long spelling as the same name). A long spelling that names a different
 *     emoji than its `_toneN` twin is listed under its own name as well.
 *   - names with two tones (`handshake_tone1_tone2`) are left out: they name
 *     mixed-tone sequences the emoji picker cannot produce either.
 *
 * Values are the emoji itself, in emoji-mart's form when emoji-mart has the
 * emoji (so the renderer can find its skin tones) and in Discord's otherwise.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://emzi0767.gl-pages.emzi0767.dev/discord-emoji/discordEmojiMap.min.json';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(root, 'packages/web/src/utils/discordEmojiAliases.ts');

/** The shortcode name syntax the renderer accepts (emojiShortcodes.ts). */
const NAME = /^[a-z0-9_+-]+$/;
const TONE_WORDS = ['light', 'medium_light', 'medium', 'medium_dark', 'dark'];
const SINGLE_TONE = new RegExp(`^(.+?)_(?:tone([1-5])|(${TONE_WORDS.join('|')})_skin_tone)$`);
const TWO_TONES = new RegExp(`(?:_tone[1-5]|_(?:${TONE_WORDS.join('|')})_skin_tone){2}$`);

const normaliseName = (name) => name.replace(/-/g, '_');
const stripVariation = (text) => text.replace(/️/g, '');

async function loadSource() {
  const flag = process.argv.indexOf('--source');
  if (flag !== -1) {
    const file = process.argv[flag + 1];
    if (!file) throw new Error('--source needs a file path');
    return { json: JSON.parse(readFileSync(file, 'utf8')), from: path.basename(file) };
  }
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`GET ${SOURCE_URL} answered ${response.status}`);
  return { json: await response.json(), from: SOURCE_URL };
}

function loadEmojiMart() {
  const requireFromWeb = createRequire(path.join(root, 'packages/web/package.json'));
  const data = requireFromWeb('@emoji-mart/data');
  const byName = new Map();
  for (const [id, emoji] of Object.entries(data.emojis)) byName.set(normaliseName(id), emoji);
  for (const [alias, id] of Object.entries(data.aliases)) {
    if (data.emojis[id]) byName.set(normaliseName(alias), data.emojis[id]);
  }
  const byNative = new Map();
  for (const emoji of Object.values(data.emojis)) {
    const base = emoji.skins[0]?.native;
    if (base) byNative.set(stripVariation(base), emoji);
  }
  return { byName, byNative };
}

async function main() {
  const { json, from } = await loadSource();
  if (!Array.isArray(json.emojiDefinitions) || typeof json.version !== 'string') {
    throw new Error('source does not look like a Discord Emoji Map (no emojiDefinitions/version)');
  }
  const emojiMart = loadEmojiMart();

  /** Discord name → Discord's emoji, for names the renderer can parse. */
  const discord = new Map();
  for (const definition of json.emojiDefinitions) {
    for (const name of definition.names) {
      if (!NAME.test(name)) continue;
      const key = normaliseName(name);
      const previous = discord.get(key);
      if (previous !== undefined && stripVariation(previous) !== stripVariation(definition.surrogates)) {
        throw new Error(`"${name}" names two different emoji once - is read as _`);
      }
      discord.set(key, definition.surrogates);
    }
  }

  /** The emoji in emoji-mart's form when emoji-mart has it. */
  const preferredForm = (native) => emojiMart.byNative.get(stripVariation(native))?.skins[0]?.native ?? native;

  const table = new Map();
  let twoTone = 0;
  let conflicts = 0;
  const tonedNames = [];

  for (const [name, native] of discord) {
    const martEmoji = emojiMart.byName.get(name);
    if (martEmoji) {
      if (stripVariation(martEmoji.skins[0].native) !== stripVariation(native)) conflicts += 1;
      continue;
    }
    if (TWO_TONES.test(name)) { twoTone += 1; continue; }
    if (SINGLE_TONE.test(name)) { tonedNames.push(name); continue; }
    table.set(name, preferredForm(native));
  }

  // The renderer's tone rule: resolve the base name (emoji-mart first, then
  // this table), find the emoji-mart entry for that emoji, take skin N.
  const resolveBase = (base) => emojiMart.byName.get(base)
    ?? emojiMart.byNative.get(stripVariation(table.get(base) ?? ''));
  let toneRuleCovers = 0;
  // `_toneN` spellings first, so a long spelling can be compared with its twin.
  const shortFirst = [...tonedNames].sort((a, b) => Number(!/_tone[1-5]$/.test(a)) - Number(!/_tone[1-5]$/.test(b)));
  for (const name of shortFirst) {
    const [, base, digit, word] = SINGLE_TONE.exec(name);
    const tone = digit ? Number(digit) : TONE_WORDS.indexOf(word) + 1;
    const expected = discord.get(name);
    const canonical = `${base}_tone${tone}`;
    const listed = table.get(canonical);
    if (listed !== undefined) {
      if (stripVariation(listed) !== stripVariation(expected)) table.set(name, expected);
      continue;
    }
    const ruled = resolveBase(base)?.skins[tone]?.native;
    if (ruled && stripVariation(ruled) === stripVariation(expected)) { toneRuleCovers += 1; continue; }
    table.set(canonical, expected);
  }

  const entries = [...table.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries.map(([name, native]) => `  ${JSON.stringify(name)}: ${JSON.stringify(native)},`).join('\n');
  const output = `// Generated by scripts/gen-discord-emoji-aliases.mjs. Do not edit by hand;
// run the script to regenerate.
//
// Source: ${from}
// Discord Emoji Map version ${json.version} (${json.versionTimestamp ?? 'no timestamp'}), ${json.discordClient ?? 'unknown'} client.
//
// ${entries.length} names. Left out: names emoji-mart already resolves (${conflicts} of them name a
// different emoji on Discord; emoji-mart wins), ${toneRuleCovers} toned names the renderer's tone rule
// covers, and ${twoTone} two-tone names.

/** Discord shortcode name (\`-\` written as \`_\`) → emoji. */
export const DISCORD_EMOJI_ALIASES: Readonly<Record<string, string>> = {
${body}
};
`;
  writeFileSync(OUTPUT, output);
  console.log(`wrote ${path.relative(root, OUTPUT)}: ${entries.length} names (${toneRuleCovers} toned names by rule, ${twoTone} two-tone names left out, ${conflicts} conflicts resolved to emoji-mart)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
