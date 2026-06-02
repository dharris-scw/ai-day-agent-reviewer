import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpawnCommandRunner, type CommandRunner, runOrThrow } from '../shared/command.js';
import type { PullRequestMetadata } from '../github/types.js';

export const WORKSPACE_ROOT = '/tmp/agent-review';

export interface WorkspaceHandle {
  rootDir: string;
  repoDir: string;
  baseSha: string;
  headSha: string;
  cleanup(): Promise<void>;
}

function repoSlug(metadata: PullRequestMetadata): string {
  const unsafe = `${metadata.repository.owner}-${metadata.repository.name}-${metadata.number}`;
  return unsafe.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export class WorkspaceManager {
  private runner: CommandRunner;

  constructor(runner: CommandRunner = new SpawnCommandRunner()) {
    this.runner = runner;
  }

  async createWorkspace(metadata: PullRequestMetadata): Promise<WorkspaceHandle> {
    await mkdir(WORKSPACE_ROOT, { recursive: true });

    const rootDir = path.join(WORKSPACE_ROOT, `${repoSlug(metadata)}-${randomUUID()}`);
    const repoDir = path.join(rootDir, 'repo');

    await mkdir(rootDir, { recursive: true });

    const cleanup = async (): Promise<void> => {
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    };

    try {
      const remoteUrl = `https://github.com/${metadata.repository.owner}/${metadata.repository.name}.git`;

      await runOrThrow(this.runner, 'git', [
        'clone',
        '--no-checkout',
        '--depth',
        '1',
        '--filter=blob:none',
        remoteUrl,
        repoDir,
      ]);

      await runOrThrow(this.runner, 'git', [
        '-C',
        repoDir,
        'fetch',
        '--depth',
        '1',
        'origin',
        metadata.baseSha,
      ]);

      await runOrThrow(this.runner, 'git', [
        '-C',
        repoDir,
        'fetch',
        '--depth',
        '1',
        'origin',
        `pull/${metadata.number}/head:refs/remotes/origin/agent-review/pr-${metadata.number}`,
      ]);

      await runOrThrow(this.runner, 'git', [
        '-C',
        repoDir,
        'checkout',
        '--detach',
        `refs/remotes/origin/agent-review/pr-${metadata.number}`,
      ]);

      const headResult = await runOrThrow(this.runner, 'git', [
        '-C',
        repoDir,
        'rev-parse',
        'HEAD',
      ]);

      const resolvedHeadSha = headResult.stdout.trim() || metadata.headSha;

      return {
        rootDir,
        repoDir,
        baseSha: metadata.baseSha,
        headSha: resolvedHeadSha,
        cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async withWorkspace<T>(
    metadata: PullRequestMetadata,
    callback: (workspace: WorkspaceHandle) => Promise<T>,
  ): Promise<T> {
    const workspace = await this.createWorkspace(metadata);
    try {
      return await callback(workspace);
    } finally {
      await workspace.cleanup();
    }
  }
}
