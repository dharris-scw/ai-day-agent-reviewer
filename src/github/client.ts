import { CommandExecutionError, type CommandRunner, SpawnCommandRunner, runOrThrow } from '../shared/command.js';
import { parseUnifiedDiff } from './diff.js';
import type {
  AuthenticatedGitHubTeam,
  AuthenticatedGitHubUser,
  ExistingReviewSummary,
  PreparedFileComment,
  PreparedLineComment,
  PreparedReviewPayload,
  PreparedReviewSubmission,
  PullRequestCandidate,
  PullRequestDiscoveryFilters,
  PullRequestMetadata,
  PullRequestRef,
  RepositoryRef,
  ReviewFinding,
  ReviewSeverity,
  ReviewVerdict,
  SkipMetadata,
  SubmitReviewInput,
  SubmitReviewResult,
} from './types.js';

const DEFAULT_HOST = 'github.com';
const REVIEWED_HEAD_MARKER = 'agent-review:reviewed-head=';
const QUEUE_DISCOVERY_UPDATED_WINDOW_DAYS = 7;

interface GitHubClientLogger {
  warn(message: string): void;
}

function repositoryFullName(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.name}`;
}

function reviewFooter(headSha: string): string {
  return `<!-- ${REVIEWED_HEAD_MARKER}${headSha} -->`;
}

function ensureTrailingMarker(summary: string, headSha: string): string {
  const marker = reviewFooter(headSha);
  return summary.includes(marker) ? summary : `${summary.trim()}\n\n${marker}`;
}

function severityLabel(severity: ReviewSeverity): string {
  return severity.toUpperCase();
}

function formatFindingBody(finding: ReviewFinding): string {
  const heading = `[${severityLabel(finding.severity)}] ${finding.title}`;
  const category = finding.category ? `Category: ${finding.category}` : undefined;
  return [heading, category, finding.body.trim()].filter(Boolean).join('\n\n');
}

function normalizeRepoInput(repo?: string): RepositoryRef | undefined {
  if (!repo) {
    return undefined;
  }

  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo filter "${repo}". Expected owner/name.`);
  }

  return {
    owner: parts[0],
    name: parts[1],
    host: DEFAULT_HOST,
  };
}

function parseDiscoveryItem(item: any): PullRequestCandidate {
  const repoNameWithOwner =
    item.repository?.nameWithOwner ??
    [
      item.repository?.owner?.login,
      item.repository?.name,
    ]
      .filter(Boolean)
      .join('/');
  const [owner, name] = String(repoNameWithOwner).split('/');

  return {
    repository: {
      owner,
      name,
      host: DEFAULT_HOST,
    },
    number: Number(item.number),
    title: String(item.title ?? ''),
    url: String(item.url ?? ''),
  };
}

function parseAuthenticatedUser(item: any): AuthenticatedGitHubUser {
  return {
    login: String(item?.login ?? ''),
  };
}

function parseAuthenticatedTeam(item: any): AuthenticatedGitHubTeam | undefined {
  const organizationLogin = String(item?.organization?.login ?? '').trim();
  const slug = String(item?.slug ?? '').trim();
  if (!organizationLogin || !slug) {
    return undefined;
  }

  return {
    organizationLogin,
    slug,
  };
}

function parseMetadataItem(item: any, fallback: PullRequestRef): PullRequestMetadata {
  const files = Array.isArray(item.files) ? parsePullRequestFiles(item.files) : [];

  return {
    ...fallback,
    title: String(item.title ?? ''),
    url: String(item.url ?? ''),
    body: String(item.body ?? ''),
    baseRefName: String(item.baseRefName ?? ''),
    headRefName: String(item.headRefName ?? ''),
    baseSha: String(item.baseRefOid ?? item.baseRefOid ?? item.baseOid ?? ''),
    headSha: String(item.headRefOid ?? item.headOid ?? ''),
    changedFiles: files,
    isDraft: item.isDraft === undefined ? undefined : Boolean(item.isDraft),
  };
}

function parsePullRequestFiles(items: any[]): PullRequestMetadata['changedFiles'] {
  return items.map((file: any) => ({
    path: String(file.path ?? file.filename ?? ''),
    additions: file.additions === undefined ? undefined : Number(file.additions),
    deletions: file.deletions === undefined ? undefined : Number(file.deletions),
    changes: file.changes === undefined ? undefined : Number(file.changes),
    status: file.status === undefined ? undefined : String(file.status),
    patch: file.patch === undefined ? undefined : String(file.patch),
    previousPath: file.previous_filename === undefined ? undefined : String(file.previous_filename),
  }));
}

function buildSyntheticDiff(files: PullRequestMetadata['changedFiles']): string {
  return files
    .map((file) => {
      const oldPath = file.previousPath ?? file.path;
      const newPath = file.status === 'removed' ? '/dev/null' : `b/${file.path}`;
      return [
        `diff --git a/${oldPath} b/${file.path}`,
        file.status === 'renamed' && file.previousPath ? `rename from ${file.previousPath}` : undefined,
        file.status === 'renamed' ? `rename to ${file.path}` : undefined,
        file.status === 'added' ? 'new file mode 100644' : undefined,
        file.status === 'removed' ? 'deleted file mode 100644' : undefined,
        `--- ${file.status === 'added' ? '/dev/null' : `a/${oldPath}`}`,
        `+++ ${newPath}`,
        file.patch?.trimEnd(),
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

function extractReviewedHeadSha(body: string): string | undefined {
  const match = new RegExp(`${REVIEWED_HEAD_MARKER}([a-f0-9]{7,40})`).exec(body);
  return match?.[1];
}

function shouldRetryGitHubCommand(error: unknown): boolean {
  if (!(error instanceof CommandExecutionError)) {
    return false;
  }

  const text = `${error.stderr}\n${error.stdout}`.toLowerCase();
  return text.includes('secondary rate limit') || text.includes('rate limit exceeded');
}

function isDiffTooLargeError(error: unknown): boolean {
  if (!(error instanceof CommandExecutionError)) {
    return false;
  }

  const text = `${error.stderr}\n${error.stdout}`.toLowerCase();
  return text.includes('pullrequest.diff too_large') || text.includes('diff exceeded the maximum number of lines');
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildQueueDiscoveryUpdatedCutoff(now: Date = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - QUEUE_DISCOVERY_UPDATED_WINDOW_DAYS);
  return formatDateOnly(cutoff);
}

function buildQueueDiscoveryKey(candidate: PullRequestCandidate): string {
  const host = candidate.repository.host ?? DEFAULT_HOST;
  return `${host}/${candidate.repository.owner}/${candidate.repository.name}#${candidate.number}`;
}

function flattenPaginatedApiResponse(parsed: unknown): any[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => (Array.isArray(item) ? item : [item]));
  }

  return [];
}

async function runGhWithRetry(
  runner: CommandRunner,
  args: string[],
  stdin?: string,
): Promise<string> {
  const delays = [0, 500, 1500];

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) {
      await sleep(delays[attempt]);
    }

    try {
      const result = await runOrThrow(runner, 'gh', args, stdin === undefined ? undefined : { stdin });
      return result.stdout;
    } catch (error) {
      if (attempt === delays.length - 1 || !shouldRetryGitHubCommand(error)) {
        throw error;
      }
    }
  }

  throw new Error('Unreachable retry branch');
}

export class GitHubClient {
  private runner: CommandRunner;
  private authenticatedLoginPromise?: Promise<string>;
  private logger: GitHubClientLogger;

  constructor(runner: CommandRunner = new SpawnCommandRunner(), logger: GitHubClientLogger = console) {
    this.runner = runner;
    this.logger = logger;
  }

  async resolveAuthenticatedLogin(): Promise<string> {
    if (!this.authenticatedLoginPromise) {
      this.authenticatedLoginPromise = (async () => {
        const stdout = await runGhWithRetry(this.runner, ['api', 'user']);
        const user = parseAuthenticatedUser(JSON.parse(stdout));
        if (!user.login) {
          throw new Error('Unable to resolve authenticated GitHub login.');
        }
        return user.login;
      })().catch((error) => {
        this.authenticatedLoginPromise = undefined;
        throw error;
      });
    }

    return this.authenticatedLoginPromise;
  }

  async resolveAuthenticatedTeams(): Promise<AuthenticatedGitHubTeam[]> {
    const stdout = await runGhWithRetry(this.runner, ['api', 'user/teams', '--paginate', '--slurp']);
    const parsed = JSON.parse(stdout);
    return flattenPaginatedApiResponse(parsed)
      .map(parseAuthenticatedTeam)
      .filter((team): team is AuthenticatedGitHubTeam => team !== undefined);
  }

  private async searchPullRequests(queryTerms: string[]): Promise<PullRequestCandidate[]> {
    const args = [
      'search',
      'prs',
      '--state=open',
      '--json',
      'number,title,url,repository',
      '--',
      ...queryTerms,
    ];
    const stdout = await runGhWithRetry(this.runner, args);
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.map(parseDiscoveryItem) : [];
  }

  async discoverPullRequests(filters: PullRequestDiscoveryFilters = {}): Promise<PullRequestCandidate[]> {
    const repoFilter = normalizeRepoInput(filters.repo);
    const authenticatedLogin = await this.resolveAuthenticatedLogin();
    const queueTerms = [
      'is:open',
      '-is:draft',
      `updated:>=${buildQueueDiscoveryUpdatedCutoff()}`,
      `-reviewed-by:${authenticatedLogin}`,
    ];
    if (filters.org) {
      queueTerms.push(`org:${filters.org}`);
    }
    if (repoFilter) {
      queueTerms.push(`repo:${repositoryFullName(repoFilter)}`);
    }
    if (filters.pr !== undefined) {
      queueTerms.push(`number:${filters.pr}`);
    }

    const results = new Map<string, PullRequestCandidate>();
    const directMatches = await this.searchPullRequests([
      'user-review-requested:@me',
      ...queueTerms,
    ]);
    for (const candidate of directMatches) {
      results.set(buildQueueDiscoveryKey(candidate), candidate);
    }

    let teams: AuthenticatedGitHubTeam[] = [];
    try {
      teams = await this.resolveAuthenticatedTeams();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Unable to resolve GitHub team memberships; continuing with direct review requests only. ${message}`);
      return [...results.values()];
    }

    const scopedTeams = teams.filter((team) => {
      if (filters.org && team.organizationLogin !== filters.org) {
        return false;
      }
      if (repoFilter && team.organizationLogin !== repoFilter.owner) {
        return false;
      }
      return true;
    });

    for (const team of scopedTeams) {
      try {
        const teamMatches = await this.searchPullRequests([
          `team-review-requested:${team.organizationLogin}/${team.slug}`,
          ...queueTerms,
        ]);
        for (const candidate of teamMatches) {
          results.set(buildQueueDiscoveryKey(candidate), candidate);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Unable to search pull requests for team ${team.organizationLogin}/${team.slug}; continuing with the remaining review queue. ${message}`
        );
      }
    }

    return [...results.values()];
  }

  async getPullRequestMetadata(pullRequest: PullRequestRef): Promise<PullRequestMetadata> {
    const args = [
      'pr',
      'view',
      String(pullRequest.number),
      '--repo',
      repositoryFullName(pullRequest.repository),
      '--json',
      'title,body,url,baseRefName,headRefName,baseRefOid,headRefOid,files,isDraft',
    ];
    const stdout = await runGhWithRetry(this.runner, args);
    return parseMetadataItem(JSON.parse(stdout), pullRequest);
  }

  async getPullRequestDiff(pullRequest: PullRequestRef): Promise<string> {
    const args = [
      'pr',
      'diff',
      String(pullRequest.number),
      '--repo',
      repositoryFullName(pullRequest.repository),
      '--patch',
    ];
    try {
      const stdout = await runGhWithRetry(this.runner, args);
      return stdout;
    } catch (error) {
      if (!isDiffTooLargeError(error)) {
        throw error;
      }

      const endpoint = `repos/${repositoryFullName(pullRequest.repository)}/pulls/${pullRequest.number}/files`;
      const stdout = await runGhWithRetry(this.runner, ['api', endpoint, '--paginate']);
      const parsed = JSON.parse(stdout);
      const files = Array.isArray(parsed) ? parsePullRequestFiles(parsed) : [];
      return buildSyntheticDiff(files);
    }
  }

  async getExistingReviews(pullRequest: PullRequestRef): Promise<ExistingReviewSummary[]> {
    const endpoint = `repos/${repositoryFullName(pullRequest.repository)}/pulls/${pullRequest.number}/reviews`;
    const stdout = await runGhWithRetry(this.runner, ['api', endpoint, '--paginate']);
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed)
      ? parsed.map((review: any) => ({
          id: Number(review.id),
          state: String(review.state ?? ''),
          body: String(review.body ?? ''),
          submittedAt: review.submitted_at === undefined ? undefined : String(review.submitted_at),
          authorLogin: review.user?.login === undefined ? undefined : String(review.user.login),
        }))
      : [];
  }

  buildSkipMetadata(headSha: string, reviews: ExistingReviewSummary[]): SkipMetadata {
    const reviewed = reviews
      .map((review) => ({
        headSha: extractReviewedHeadSha(review.body),
        submittedAt: review.submittedAt,
      }))
      .filter((review) => review.headSha !== undefined);

    return {
      currentHeadSha: headSha,
      reviewedHeadShas: reviewed.map((review) => review.headSha).filter((value): value is string => value !== undefined),
      alreadyReviewedCurrentHead: reviewed.some((review) => review.headSha === headSha),
      latestReviewedAt: reviewed
        .filter((review) => review.headSha === headSha)
        .map((review) => review.submittedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1),
    };
  }

  prepareReviewSubmission(input: SubmitReviewInput): PreparedReviewSubmission {
    const diffIndex = parseUnifiedDiff(input.diff);
    const lineComments: PreparedLineComment[] = [];
    const fileComments: PreparedFileComment[] = [];
    const summaryNotes: { body: string }[] = [];

    for (const finding of input.findings) {
      const body = formatFindingBody(finding);
      if (!finding.path) {
        summaryNotes.push({ body });
        continue;
      }

      const file = diffIndex.files.get(finding.path);
      if (!file) {
        summaryNotes.push({ body: `${body}\n\nAffected path: ${finding.path}` });
        continue;
      }

      if (finding.line === undefined || finding.line === null) {
        fileComments.push({
          body,
          path: finding.path,
          subject_type: 'file',
        });
        continue;
      }

      if (file.commentableLines.has(finding.line)) {
        lineComments.push({
          body,
          path: finding.path,
          line: finding.line,
          side: 'RIGHT',
          subject_type: 'line',
        });
        continue;
      }

      fileComments.push({
        body: `${body}\n\nDowngraded from line ${finding.line} because the diff no longer exposes a valid RIGHT-side line.`,
        path: finding.path,
        subject_type: 'file',
      });
    }

    const endpointBase = `repos/${repositoryFullName(input.pullRequest.repository)}/pulls/${input.pullRequest.number}`;
    const commentPayloads: PreparedReviewPayload[] = [
      ...lineComments.map((comment) => ({
        method: 'POST' as const,
        endpoint: `${endpointBase}/comments`,
        body: {
          body: comment.body,
          commit_id: input.headSha,
          path: comment.path,
          line: comment.line,
          side: comment.side,
          subject_type: comment.subject_type,
        },
      })),
      ...fileComments.map((comment) => ({
        method: 'POST' as const,
        endpoint: `${endpointBase}/comments`,
        body: {
          body: comment.body,
          commit_id: input.headSha,
          path: comment.path,
          subject_type: comment.subject_type,
        },
      })),
    ];

    const summaryBodies = [
      input.summary.trim(),
      summaryNotes.length > 0
        ? ['Additional findings without valid inline targets:', ...summaryNotes.map((note) => `- ${note.body.replace(/\n/g, '\n  ')}`)].join('\n')
        : undefined,
    ].filter(Boolean);

    const review: PreparedReviewPayload = {
      method: 'POST',
      endpoint: `${endpointBase}/reviews`,
      body: {
        body: ensureTrailingMarker(summaryBodies.join('\n\n'), input.headSha),
        event: input.verdict,
      },
    };

    return {
      lineComments,
      fileComments,
      summaryNotes,
      review,
      requests: [...commentPayloads, review],
    };
  }

  async submitReview(input: SubmitReviewInput): Promise<SubmitReviewResult> {
    const prepared = this.prepareReviewSubmission(input);

    if (input.dryRun) {
      return {
        dryRun: true,
        payloads: prepared.requests,
      };
    }

    for (const payload of prepared.requests) {
      await runGhWithRetry(this.runner, [
        'api',
        payload.endpoint,
        '--method',
        payload.method,
        '--input',
        '-',
      ], `${JSON.stringify(payload.body)}\n`);
    }

    return {
      dryRun: false,
      payloads: prepared.requests,
    };
  }
}

export {
  REVIEWED_HEAD_MARKER,
  extractReviewedHeadSha,
  formatFindingBody,
  reviewFooter,
};
