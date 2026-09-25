import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { releaseSummary } from './release-summary.mjs';

const script = fileURLToPath(new URL('./release-summary.mjs', import.meta.url));

// The published v1.5.2 notes, abridged after the summary: everything below the
// first `##` is never read, but its shape (sections, a list, the Downloads
// table) is what the extraction must stop in front of.
const notes152 = [
  '# Backspace 1.5.2',
  '',
  'A Backspace page for project information, and clearer federation messages.',
  '',
  '## The Backspace page',
  '',
  'The "Coming Soon" item in the direct messages sidebar is now "Backspace".',
  '',
  '## Federation',
  '',
  '- Connecting to an instance that has closed federated registration no longer says an account already exists there (#279).',
  '',
  '## Downloads',
  '',
  '| Platform | Download |',
  '|---|---|',
  '| Windows x64 | [Backspace-1.5.2-win-x64.exe](https://github.com/TheZwiss/backspace/releases/download/v1.5.2/Backspace-1.5.2-win-x64.exe) |',
].join('\n');

test('takes the first paragraph of the 1.5.2 release notes', () => {
  assert.equal(
    releaseSummary(notes152, '1.5.2'),
    'A Backspace page for project information, and clearer federation messages.',
  );
});

test('reads CRLF line endings as the same notes', () => {
  assert.equal(
    releaseSummary(notes152.replace(/\n/g, '\r\n'), '1.5.2'),
    'A Backspace page for project information, and clearer federation messages.',
  );
});

test('ignores blank lines before the heading and trailing spaces on it', () => {
  assert.equal(
    releaseSummary('\n  \n# Backspace 1.5.2  \n\nShort summary.\n', '1.5.2'),
    'Short summary.',
  );
});

test('joins a paragraph wrapped over several lines with single spaces', () => {
  const body = [
    '# Backspace 2.0.0',
    '',
    'Spaces on other instances are findable now,',
    '   and joining one connects you to its instance first.  ',
    'Listing is opt in on both sides.',
    '',
    'A second paragraph that is not part of the summary.',
  ].join('\n');
  assert.equal(
    releaseSummary(body, '2.0.0'),
    'Spaces on other instances are findable now, and joining one connects you to its instance first. Listing is opt in on both sides.',
  );
});

// Markdown lets a heading, a list or a table start without a blank line in
// front of it; none of them may end up inside the summary.
for (const [name, next] of [
  ['section heading', '## Details'],
  ['dash list', '- first change'],
  ['star list', '* first change'],
  ['table', '| Platform | Download |'],
  ['plus list', '+ first change'],
  ['block quote', '> quoted'],
  ['code fence', '```sh'],
  ['raw HTML block', '<details>'],
  ['ordered list', '1. first change'],
  ['ordered list with a parenthesis', '2) second change'],
]) {
  test(`ends the paragraph at a ${name} that follows it directly`, () => {
    const body = `# Backspace 1.0.0\n\nOne line of summary.\n${next}\n\nMore.`;
    assert.equal(releaseSummary(body, '1.0.0'), 'One line of summary.');
  });
}

test('reduces links to their text and drops emphasis and code markers', () => {
  const body = [
    '# Backspace 1.6.0',
    '',
    'Adds **bold** and __strong__ words, *light* and _soft_ ones, the `backspace://` scheme',
    'and a [release page](https://github.com/TheZwiss/backspace/releases) with [`code` in it](https://example.com/a_(b)).',
  ].join('\n');
  assert.equal(
    releaseSummary(body, '1.6.0'),
    'Adds bold and strong words, light and soft ones, the backspace:// scheme and a release page with code in it.',
  );
});

test('leaves underscores and asterisks that are not emphasis alone', () => {
  const body = '# Backspace 1.6.0\n\nThe snake_case_name setting, `a_b_c`, 2 * 3 and a lone _ stay.';
  assert.equal(
    releaseSummary(body, '1.6.0'),
    'The snake_case_name setting, a_b_c, 2 * 3 and a lone _ stay.',
  );
});

test('keeps backslash-escaped characters as the literal characters', () => {
  const body = '# Backspace 1.6.0\n\nAdds \\*literal stars\\*, a \\[bracket\\](not a link), a \\_ mark, \\#7 and a \\\\ backslash.';
  assert.equal(
    releaseSummary(body, '1.6.0'),
    'Adds *literal stars*, a [bracket](not a link), a _ mark, #7 and a \\ backslash.',
  );
});

test('leaves a backslash before an ordinary character alone', () => {
  const body = '# Backspace 1.6.0\n\nPaths like C:\\Users and 50\\% stay.';
  assert.equal(releaseSummary(body, '1.6.0'), 'Paths like C:\\Users and 50\\% stay.');
});

test('keeps backslashes inside inline code', () => {
  const body = '# Backspace 1.6.0\n\nType `\\*` to match.';
  assert.equal(releaseSummary(body, '1.6.0'), 'Type \\* to match.');
});

test('reduces an image to its alt text', () => {
  const body = '# Backspace 1.6.0\n\nSee ![the new logo](https://example.com/logo.png) on every **icon**.';
  assert.equal(releaseSummary(body, '1.6.0'), 'See the new logo on every icon.');
});

test('reads a paragraph that opens with a version number as prose', () => {
  const body = '# Backspace 1.6.0\n\n1.6.0 makes screen sharing faster.';
  assert.equal(releaseSummary(body, '1.6.0'), '1.6.0 makes screen sharing faster.');
});

test('keeps emphasis markers inside inline code', () => {
  const body = '# Backspace 1.6.0\n\nRun `pnpm **bump**` to start.';
  assert.equal(releaseSummary(body, '1.6.0'), 'Run pnpm **bump** to start.');
});

for (const [name, body, version, error] of [
  ['an empty body', '', '1.5.2', /no "# Backspace 1\.5\.2" heading/],
  ['notes without a heading', 'A summary without a title.\n', '1.5.2', /first line to be "# Backspace 1\.5\.2", found "A summary without a title\."/],
  ['a heading for another version', notes152.replace('# Backspace 1.5.2', '# Backspace 1.5.1'), '1.5.2', /first line to be "# Backspace 1\.5\.2", found "# Backspace 1\.5\.1"/],
  ['a heading of the wrong level', notes152.replace('# Backspace', '## Backspace'), '1.5.2', /first line to be "# Backspace 1\.5\.2"/],
  ['a heading followed by nothing', '# Backspace 1.5.2\n\n  \n', '1.5.2', /no summary paragraph/],
  ['a section heading straight after the title', '# Backspace 1.5.2\n\n## Downloads\n\n| a | b |\n', '1.5.2', /starts with "#"/],
  ['a table straight after the title', '# Backspace 1.5.2\n\n| Platform | Download |\n|---|---|\n', '1.5.2', /starts with "\|"/],
  ['a dash list straight after the title', '# Backspace 1.5.2\n\n- one\n- two\n', '1.5.2', /starts with "-"/],
  ['a star list straight after the title', '# Backspace 1.5.2\n\n* one\n* two\n', '1.5.2', /starts with "\*"/],
  ['a paragraph of markup only', '# Backspace 1.5.2\n\n** **\n', '1.5.2', /starts with "\*"/],
  ['a block quote straight after the title', '# Backspace 1.5.2\n\n> quoted\n', '1.5.2', /starts with ">"/],
  ['a plus list straight after the title', '# Backspace 1.5.2\n\n+ one\n+ two\n', '1.5.2', /starts with "\+"/],
  ['a code fence straight after the title', '# Backspace 1.5.2\n\n```sh\npnpm bump\n```\n', '1.5.2', /starts with "```"/],
  ['raw HTML straight after the title', '# Backspace 1.5.2\n\n<p>Hello</p>\n', '1.5.2', /starts with "</],
  ['an ordered list straight after the title', '# Backspace 1.5.2\n\n1. one\n2. two\n', '1.5.2', /starts with "1\."/],
  ['a link with empty text', '# Backspace 1.5.2\n\n[](https://example.com)\n', '1.5.2', /empty once its Markdown is removed/],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => releaseSummary(body, version), error);
  });
}

test('rejects a version that is not X.Y.Z', () => {
  assert.throws(() => releaseSummary(notes152, 'v1.5.2'), /version such as 1\.5\.2/);
});

test('command line prints the summary for the version given', () => {
  const result = spawnSync(process.execPath, [script, '1.5.2'], { input: notes152, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'A Backspace page for project information, and clearer federation messages.\n');
  assert.equal(result.stderr, '');
});

test('command line fails with the reason and prints nothing on stdout', () => {
  const result = spawnSync(process.execPath, [script, '1.5.2'], { input: '# Backspace 1.5.2\n\n## Downloads\n', encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /starts with "#"/);
  assert.doesNotMatch(result.stderr, /    at /, 'no stack trace, only the reason');
});
