import { readFileSync } from 'node:fs';
import { GitHubClient, type PullRequest } from './github.ts';
import { analyze } from './analyze.ts';
import { render, MARKER } from './report.ts';
import type { Triage } from './types.ts';

/**
 * Entry point for `.github/workflows/pr-triage.yml`.
 *
 * Reads the pull request number from `PR_NUMBER` (a `workflow_dispatch`
 * input) or from the `pull_request_target` event payload, fetches what the
 * PR changed, runs the analysis and posts or updates the triage comment.
 * `--dry-run` prints the comment instead of posting it.
 *
 * Nothing here executes any content of the pull request. File contents
 * are fetched as text and parsed; the event payload is read for the PR
 * number only. Every string from the PR that reaches the comment goes
 * through `sanitize.ts` inside `report.ts`.
 *
 * On any failure after the PR is known, the bot posts (or updates to) a
 * "could not analyse" comment and exits non-zero. A failure the maintainer
 * can see is the intended behaviour; a silent skip would look like a
 * routine PR that was never triaged.
 */

const BOT_LOGIN = 'github-actions[bot]';

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

function readPullNumber(): { number: number; dispatched: boolean } {
  const fromInput = process.env['PR_NUMBER'];
  if (fromInput !== undefined && fromInput !== '') {
    if (!/^\d{1,9}$/.test(fromInput)) throw new Error(`PR_NUMBER is not a pull request number: ${JSON.stringify(fromInput)}`);
    return { number: Number(fromInput), dispatched: true };
  }
  const eventPath = env('GITHUB_EVENT_PATH');
  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as { pull_request?: { number?: unknown } };
  const number = event.pull_request?.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new Error('event payload has no pull_request.number');
  }
  return { number, dispatched: false };
}

async function upsertComment(client: GitHubClient, number: number, body: string): Promise<'created' | 'updated'> {
  const comments = await client.listIssueComments(number);
  const mine = comments.find((c) => c.user?.login === BOT_LOGIN && c.body.startsWith(MARKER));
  if (mine) {
    await client.updateIssueComment(mine.id, body);
    return 'updated';
  }
  await client.createIssueComment(number, body);
  return 'created';
}

function failClosed(pull: PullRequest | null, number: number, reason: string): Triage {
  return {
    verdict: 'unanalysable',
    headSha: pull?.head.sha ?? '',
    author: pull?.user?.login ?? '',
    totalFiles: pull?.changed_files ?? 0,
    hits: [],
    packageJson: [],
    lockfile: null,
    sources: null,
    problems: [`the triage run for #${number} failed: ${reason}`],
  };
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const repository = env('GITHUB_REPOSITORY');
  const client = new GitHubClient(env('GITHUB_TOKEN'), repository);
  const { number, dispatched } = readPullNumber();

  let pull: PullRequest | null = null;
  try {
    pull = await client.getPull(number);
    if (!dispatched && pull.head.repo?.full_name === repository) {
      console.log(`#${number} is not from a fork; nothing to triage.`);
      return 0;
    }
    const [files, mergeBase] = await Promise.all([client.listPullFiles(number), client.mergeBase(pull.base.sha, pull.head.sha)]);
    const triage = await analyze({ pull, files, mergeBase, getRawFile: (path, ref) => client.getRawFile(path, ref) });
    const body = render(triage);
    if (dryRun) {
      console.log(body);
      return 0;
    }
    const action = await upsertComment(client, number, body);
    console.log(`${action} the triage comment on #${number}: ${triage.verdict}`);
    return 0;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`triage of #${number} failed: ${reason}`);
    const body = render(failClosed(pull, number, reason));
    if (dryRun) {
      console.log(body);
    } else {
      try {
        await upsertComment(client, number, body);
      } catch (postErr) {
        console.error(`could not post the failure comment either: ${postErr instanceof Error ? postErr.message : String(postErr)}`);
      }
    }
    return 1;
  }
}

process.exitCode = await main();
