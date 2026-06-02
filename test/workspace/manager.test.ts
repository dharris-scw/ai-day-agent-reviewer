import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { WorkspaceManager, WORKSPACE_ROOT } from '../../src/workspace/manager.js';
import type { PullRequestMetadata } from '../../src/github/types.js';
import type { CommandOptions, CommandResult, CommandRunner } from '../../src/shared/command.js';

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];
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

const metadata: PullRequestMetadata = {
  repository: {
    owner: 'acme',
    name: 'widget',
    host: 'github.com',
  },
  number: 42,
  title: 'Example',
  url: 'https://github.com/acme/widget/pull/42',
  body: '',
  baseRefName: 'main',
  headRefName: 'feature',
  baseSha: '1111111111111111111111111111111111111111',
  headSha: '2222222222222222222222222222222222222222',
  changedFiles: [],
};

test('createWorkspace uses /tmp/agent-review and fetches base plus PR head', async () => {
  const runner = new FakeRunner([
    { stdout: '', stderr: '', exitCode: 0 },
    { stdout: '', stderr: '', exitCode: 0 },
    { stdout: '', stderr: '', exitCode: 0 },
    { stdout: '', stderr: '', exitCode: 0 },
    { stdout: `${metadata.headSha}\n`, stderr: '', exitCode: 0 },
  ]);
  const manager = new WorkspaceManager(runner);

  const workspace = await manager.createWorkspace(metadata);
  try {
    assert.match(workspace.rootDir, new RegExp(`^${WORKSPACE_ROOT}/acme-widget-42-`));
    assert.equal(workspace.headSha, metadata.headSha);
    assert.equal(runner.calls.length, 5);
    assert.deepEqual(runner.calls[0].args, [
      'clone',
      '--no-checkout',
      '--depth',
      '1',
      '--filter=blob:none',
      'https://github.com/acme/widget.git',
      workspace.repoDir,
    ]);
    assert.deepEqual(runner.calls[1].args.slice(0, 8), [
      '-C',
      workspace.repoDir,
      'fetch',
      '--depth',
      '1',
      'origin',
      metadata.baseSha,
    ]);
    assert.match(runner.calls[2].args[6], /pull\/42\/head:refs\/remotes\/origin\/agent-review\/pr-42/);
  } finally {
    await workspace.cleanup();
  }
});

test('withWorkspace cleans up when the callback fails', async () => {
  const runner = new FakeRunner([
    { stdout: '', stderr: '', exitCode: 0 },
    { stdout: '', stderr: '', exitCode: 0 },
    { stdout: '', stderr: '', exitCode: 0 },
    { stdout: '', stderr: '', exitCode: 0 },
    { stdout: `${metadata.headSha}\n`, stderr: '', exitCode: 0 },
  ]);
  const manager = new WorkspaceManager(runner);

  let capturedRootDir = '';

  await assert.rejects(
    manager.withWorkspace(metadata, async (workspace) => {
      capturedRootDir = workspace.rootDir;
      throw new Error('boom');
    }),
    /boom/,
  );

  await assert.rejects(access(capturedRootDir), /ENOENT/);
});

test('createWorkspace cleans up partial directories on clone failure', async () => {
  const runner = new FakeRunner([
    { stdout: '', stderr: 'clone failed', exitCode: 1 },
  ]);
  const manager = new WorkspaceManager(runner);

  await assert.rejects(manager.createWorkspace(metadata), /clone failed/);
});
