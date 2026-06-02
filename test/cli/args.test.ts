import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CliArgumentError,
  parseCliArgs,
  parseRepoRef,
  resolveCliOptions,
} from '../../src/cli/args.js';

test('parseCliArgs reads required flags and booleans', () => {
  const parsed = parseCliArgs([
    '--repo=acme/widgets',
    '--pr',
    '123',
    '--org',
    'acme',
    '--dry-run',
    '--concurrency',
    '4',
    '--max-files',
    '10',
    '--max-lines',
    '250',
    '--model',
    'gpt-4.1',
    '--review-level',
    'deep',
  ]);

  assert.deepEqual(parsed, {
    repo: 'acme/widgets',
    pr: 123,
    org: 'acme',
    dryRun: true,
    noApprove: false,
    concurrency: 4,
    maxFiles: 10,
    maxLines: 250,
    model: 'gpt-4.1',
    reviewLevel: 'deep',
  });
});

test('resolveCliOptions applies env defaults and default github host', () => {
  const options = resolveCliOptions(['--repo', 'acme/widgets'], {
    OPENAI_MODEL: 'gpt-4.1-mini',
    AGENT_REVIEW_CONCURRENCY: '3',
    AGENT_REVIEW_MAX_FILES: '55',
    AGENT_REVIEW_MAX_LINES: '2400',
  });

  assert.deepEqual(options, {
    repo: {
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    },
    pr: undefined,
    org: undefined,
    dryRun: false,
    noApprove: false,
    concurrency: 3,
    maxFiles: 55,
    maxLines: 2400,
    model: 'gpt-4.1-mini',
    reviewLevel: 'normal',
  });
});

test('resolveCliOptions carries explicit review level', () => {
  const options = resolveCliOptions(
    ['--repo', 'acme/widgets', '--review-level=light'],
    {
      OPENAI_MODEL: 'gpt-4.1-mini',
    },
  );

  assert.equal(options.reviewLevel, 'light');
});

test('parseRepoRef supports explicit hosts', () => {
  assert.deepEqual(parseRepoRef('git.example.com/acme/widgets'), {
    host: 'git.example.com',
    owner: 'acme',
    repo: 'widgets',
  });
});

test('resolveCliOptions rejects repo and org mismatches', () => {
  assert.throws(
    () =>
      resolveCliOptions(['--repo', 'acme/widgets', '--org', 'other'], {
        OPENAI_MODEL: 'gpt-4.1',
      }),
    new CliArgumentError('--org=other does not match repository owner acme.'),
  );
});

test('resolveCliOptions rejects pr without repo', () => {
  assert.throws(
    () => resolveCliOptions(['--pr', '12'], { OPENAI_MODEL: 'gpt-4.1' }),
    new CliArgumentError('--pr requires --repo.'),
  );
});

test('parseCliArgs rejects invalid review level', () => {
  assert.throws(
    () => parseCliArgs(['--review-level', 'extra']),
    new CliArgumentError('--review-level must be one of: light, normal, deep.'),
  );
});
