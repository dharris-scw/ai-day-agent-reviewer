import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, REVIEWED_HEAD_MARKER } from '../../src/github/client.js';
import { CommandExecutionError, type CommandOptions, type CommandResult, type CommandRunner } from '../../src/shared/command.js';
import type { PullRequestRef, ReviewFinding } from '../../src/github/types.js';

interface RecordedCall {
  command: string;
  args: string[];
  options?: CommandOptions;
}

class FakeRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  private queue: Array<CommandResult | Error>;

  constructor(queue: Array<CommandResult | Error>) {
    this.queue = [...queue];
  }

  async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    const next = this.queue.shift();
    if (!next) {
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

function createLogger() {
  const warnings: string[] = [];
  return {
    logger: {
      warn(message: string) {
        warnings.push(message);
      },
    },
    warnings,
  };
}

const pullRequest: PullRequestRef = {
  repository: {
    owner: 'acme',
    name: 'widget',
    host: 'github.com',
  },
  number: 42,
};

const diffText = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 export function sum(a: number, b: number) {
-  return a - b;
+  const total = a + b;
+  return total;
 }
 
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const oldValue = 1;
-export const unused = 2;
`;

test('prepareReviewSubmission keeps valid RIGHT-side line comments and downgrades invalid ones', () => {
  const client = new GitHubClient(new FakeRunner([]));
  const findings: ReviewFinding[] = [
    {
      path: 'src/app.ts',
      line: 2,
      severity: 'major',
      title: 'Wrong arithmetic',
      body: 'This should add the operands.',
    },
    {
      path: 'src/old.ts',
      line: 1,
      severity: 'minor',
      title: 'Deletion needs migration note',
      body: 'Removing this file needs rollout guidance.',
    },
    {
      severity: 'major',
      title: 'Cross-file risk',
      body: 'The new flow also changes a downstream assumption.',
    },
  ];

  const prepared = client.prepareReviewSubmission({
    pullRequest,
    headSha: 'abcdef1234567890',
    diff: diffText,
    summary: 'Summary body',
    verdict: 'REQUEST_CHANGES',
    findings,
  });

  assert.equal(prepared.lineComments.length, 1);
  assert.deepEqual(prepared.lineComments[0], {
    body: '[MAJOR] Wrong arithmetic\n\nThis should add the operands.',
    line: 2,
    path: 'src/app.ts',
    side: 'RIGHT',
    subject_type: 'line',
  });

  assert.equal(prepared.fileComments.length, 1);
  assert.match(prepared.fileComments[0].body, /Downgraded from line 1/);
  assert.equal(prepared.fileComments[0].path, 'src/old.ts');

  assert.equal(prepared.summaryNotes.length, 1);
  assert.match(prepared.review.body.body as string, new RegExp(REVIEWED_HEAD_MARKER));
});

test('buildSkipMetadata extracts reviewed head SHAs from existing reviews', () => {
  const client = new GitHubClient(new FakeRunner([]));

  const metadata = client.buildSkipMetadata('deadbeef', [
    {
      id: 1,
      state: 'COMMENTED',
      body: 'Looks good\n\n<!-- agent-review:reviewed-head=deadbeef -->',
      submittedAt: '2026-06-01T10:00:00Z',
    },
    {
      id: 2,
      state: 'COMMENTED',
      body: 'Old review\n\n<!-- agent-review:reviewed-head=abc1234 -->',
      submittedAt: '2026-05-31T10:00:00Z',
    },
  ]);

  assert.deepEqual(metadata.reviewedHeadShas, ['deadbeef', 'abc1234']);
  assert.equal(metadata.alreadyReviewedCurrentHead, true);
  assert.equal(metadata.latestReviewedAt, '2026-06-01T10:00:00Z');
});

test('submitReview dry-run returns exact gh payloads without executing POSTs', async () => {
  const runner = new FakeRunner([]);
  const client = new GitHubClient(runner);

  const result = await client.submitReview({
    pullRequest,
    headSha: 'abcdef1234567890',
    diff: diffText,
    summary: 'Dry run summary',
    verdict: 'COMMENT',
    findings: [
      {
        path: 'src/app.ts',
        line: 3,
        severity: 'minor',
        title: 'Inline note',
        body: 'Nit: keep the expression simple.',
      },
    ],
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.payloads.length, 2);
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(result.payloads[0], {
    method: 'POST',
    endpoint: 'repos/acme/widget/pulls/42/comments',
    body: {
      body: '[MINOR] Inline note\n\nNit: keep the expression simple.',
      commit_id: 'abcdef1234567890',
      path: 'src/app.ts',
      line: 3,
      side: 'RIGHT',
      subject_type: 'line',
    },
  });
  assert.equal(result.payloads[1].endpoint, 'repos/acme/widget/pulls/42/reviews');
});

test('discoverPullRequests retries secondary rate limit failures', async () => {
  const { logger } = createLogger();
  const rateLimited = new CommandExecutionError(
    'gh',
    ['search', 'prs'],
    undefined,
    {
      stdout: '',
      stderr: 'secondary rate limit',
      exitCode: 1,
    },
  );
  const runner = new FakeRunner([
    {
      stdout: JSON.stringify({ login: 'reviewer' }),
      stderr: '',
      exitCode: 0,
    },
    rateLimited,
    {
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Example',
          url: 'https://github.com/acme/widget/pull/42',
          repository: { nameWithOwner: 'acme/widget' },
        },
      ]),
      stderr: '',
      exitCode: 0,
    },
    {
      stdout: JSON.stringify([]),
      stderr: '',
      exitCode: 0,
    },
  ]);
  const client = new GitHubClient(runner, logger);

  const result = await client.discoverPullRequests();

  assert.equal(runner.calls.length, 4);
  assert.deepEqual(runner.calls[0]?.args, ['api', 'user']);
  assert.deepEqual(runner.calls[1]?.args, runner.calls[2]?.args);
  assert.match(runner.calls[1]?.args.join(' '), /user-review-requested:@me/);
  assert.match(runner.calls[1]?.args.join(' '), /updated:>=\d{4}-\d{2}-\d{2}/);
  assert.match(runner.calls[1]?.args.join(' '), /-reviewed-by:reviewer/);
  assert.match(runner.calls[1]?.args.join(' '), /-is:draft/);
  assert.deepEqual(runner.calls[3]?.args, ['api', 'user/teams', '--paginate', '--slurp']);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.repository.owner, 'acme');
  assert.equal(result[0]?.number, 42);
});

test('resolveAuthenticatedLogin caches the gh api user lookup', async () => {
  const runner = new FakeRunner([
    {
      stdout: JSON.stringify({ login: 'reviewer' }),
      stderr: '',
      exitCode: 0,
    },
  ]);
  const client = new GitHubClient(runner);

  const first = await client.resolveAuthenticatedLogin();
  const second = await client.resolveAuthenticatedLogin();

  assert.equal(first, 'reviewer');
  assert.equal(second, 'reviewer');
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]?.args, ['api', 'user']);
});

test('resolveAuthenticatedTeams parses visible team memberships from gh api', async () => {
  const runner = new FakeRunner([
    {
      stdout: JSON.stringify([
        [
          {
            slug: 'backend',
            organization: { login: 'acme' },
          },
        ],
        [
          {
            slug: 'frontend',
            organization: { login: 'widgets' },
          },
          {
            slug: '',
            organization: { login: 'ignored' },
          },
        ],
      ]),
      stderr: '',
      exitCode: 0,
    },
  ]);
  const client = new GitHubClient(runner);

  const teams = await client.resolveAuthenticatedTeams();

  assert.deepEqual(teams, [
    { organizationLogin: 'acme', slug: 'backend' },
    { organizationLogin: 'widgets', slug: 'frontend' },
  ]);
  assert.deepEqual(runner.calls[0]?.args, ['api', 'user/teams', '--paginate', '--slurp']);
});

test('discoverPullRequests merges direct and team review requests and dedupes overlaps', async () => {
  const runner = new FakeRunner([
    {
      stdout: JSON.stringify({ login: 'reviewer' }),
      stderr: '',
      exitCode: 0,
    },
    {
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Direct match',
          url: 'https://github.com/acme/widget/pull/42',
          repository: { nameWithOwner: 'acme/widget' },
        },
      ]),
      stderr: '',
      exitCode: 0,
    },
    {
      stdout: JSON.stringify([
        [
          {
            slug: 'backend',
            organization: { login: 'acme' },
          },
        ],
      ]),
      stderr: '',
      exitCode: 0,
    },
    {
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Team duplicate',
          url: 'https://github.com/acme/widget/pull/42',
          repository: { nameWithOwner: 'acme/widget' },
        },
        {
          number: 77,
          title: 'Team-only match',
          url: 'https://github.com/acme/widget/pull/77',
          repository: { nameWithOwner: 'acme/widget' },
        },
      ]),
      stderr: '',
      exitCode: 0,
    },
  ]);
  const client = new GitHubClient(runner);

  const result = await client.discoverPullRequests();

  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((candidate) => candidate.number),
    [42, 77],
  );
  assert.match(runner.calls[1]?.args.join(' '), /user-review-requested:@me/);
  assert.match(runner.calls[3]?.args.join(' '), /team-review-requested:acme\/backend/);
});

test('discoverPullRequests narrows team searches with org and repo queue filters', async () => {
  const runner = new FakeRunner([
    {
      stdout: JSON.stringify({ login: 'reviewer' }),
      stderr: '',
      exitCode: 0,
    },
    {
      stdout: JSON.stringify([]),
      stderr: '',
      exitCode: 0,
    },
    {
      stdout: JSON.stringify([
        [
          {
            slug: 'backend',
            organization: { login: 'acme' },
          },
          {
            slug: 'frontend',
            organization: { login: 'widgets' },
          },
        ],
      ]),
      stderr: '',
      exitCode: 0,
    },
    {
      stdout: JSON.stringify([]),
      stderr: '',
      exitCode: 0,
    },
  ]);
  const client = new GitHubClient(runner);

  await client.discoverPullRequests({ org: 'acme', repo: 'acme/widget' });

  assert.equal(runner.calls.length, 4);
  assert.match(runner.calls[1]?.args.join(' '), /org:acme/);
  assert.match(runner.calls[1]?.args.join(' '), /repo:acme\/widget/);
  assert.match(runner.calls[3]?.args.join(' '), /team-review-requested:acme\/backend/);
  assert.doesNotMatch(runner.calls[3]?.args.join(' '), /widgets\/frontend/);
});

test('discoverPullRequests falls back to direct-only discovery when team lookup fails', async () => {
  const { logger, warnings } = createLogger();
  const runner = new FakeRunner([
    {
      stdout: JSON.stringify({ login: 'reviewer' }),
      stderr: '',
      exitCode: 0,
    },
    {
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Direct match',
          url: 'https://github.com/acme/widget/pull/42',
          repository: { nameWithOwner: 'acme/widget' },
        },
      ]),
      stderr: '',
      exitCode: 0,
    },
    new CommandExecutionError('gh', ['api', 'user/teams', '--paginate', '--slurp'], undefined, {
      stdout: '',
      stderr: 'Resource not accessible by integration',
      exitCode: 1,
    }),
  ]);
  const client = new GitHubClient(runner, logger);

  const result = await client.discoverPullRequests();

  assert.deepEqual(result.map((candidate) => candidate.number), [42]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /continuing with direct review requests only/i);
});

test('discoverPullRequests continues when a single team search fails', async () => {
  const { logger, warnings } = createLogger();
  const runner = new FakeRunner([
    {
      stdout: JSON.stringify({ login: 'reviewer' }),
      stderr: '',
      exitCode: 0,
    },
    {
      stdout: JSON.stringify([]),
      stderr: '',
      exitCode: 0,
    },
    {
      stdout: JSON.stringify([
        [
          {
            slug: 'backend',
            organization: { login: 'acme' },
          },
          {
            slug: 'frontend',
            organization: { login: 'acme' },
          },
        ],
      ]),
      stderr: '',
      exitCode: 0,
    },
    new CommandExecutionError('gh', ['search', 'prs'], undefined, {
      stdout: '',
      stderr: 'boom',
      exitCode: 1,
    }),
    {
      stdout: JSON.stringify([
        {
          number: 99,
          title: 'Second team match',
          url: 'https://github.com/acme/widget/pull/99',
          repository: { nameWithOwner: 'acme/widget' },
        },
      ]),
      stderr: '',
      exitCode: 0,
    },
  ]);
  const client = new GitHubClient(runner, logger);

  const result = await client.discoverPullRequests();

  assert.deepEqual(result.map((candidate) => candidate.number), [99]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /Unable to search pull requests for team acme\/backend/);
  assert.match(runner.calls[3]?.args.join(' '), /team-review-requested:acme\/backend/);
  assert.match(runner.calls[4]?.args.join(' '), /team-review-requested:acme\/frontend/);
});

test('getPullRequestDiff falls back to pull files API when the diff is too large', async () => {
  const diffTooLarge = new CommandExecutionError(
    'gh',
    ['pr', 'diff', '42'],
    undefined,
    {
      stdout: '',
      stderr: 'HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)\nPullRequest.diff too_large',
      exitCode: 1,
    },
  );
  const runner = new FakeRunner([
    diffTooLarge,
    {
      stdout: JSON.stringify([
        {
          filename: 'src/app.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
          patch: '@@ -1,2 +1,3 @@\n export function sum(a: number, b: number) {\n-  return a - b;\n+  const total = a + b;\n+  return total;\n }',
        },
      ]),
      stderr: '',
      exitCode: 0,
    },
  ]);
  const client = new GitHubClient(runner);

  const diff = await client.getPullRequestDiff(pullRequest);

  assert.match(diff, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.match(diff, /\+\+\+ b\/src\/app\.ts/);
  assert.match(diff, /@@ -1,2 \+1,3 @@/);
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[1]?.args[1], 'repos/acme/widget/pulls/42/files');
});
