import { resolveCliOptions } from "./cli/args.js";
import { GitHubClient } from "./github/client.js";
import type { ExistingReviewSummary, PullRequestCandidate } from "./github/types.js";
import { OpenAiReviewModel, reviewPullRequest } from "./review-engine/index.js";
import type { ReviewEngineModel } from "./review-engine/index.js";
import { createStateStore } from "./state/store.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { buildPullRequestReviewInput } from "./workspace/context.js";

type GitHubClientLike = Pick<
  GitHubClient,
  | "resolveAuthenticatedLogin"
  | "discoverPullRequests"
  | "getPullRequestMetadata"
  | "getExistingReviews"
  | "buildSkipMetadata"
  | "getPullRequestDiff"
  | "submitReview"
>;

type WorkspaceManagerLike = Pick<WorkspaceManager, "withWorkspace">;
type StateStoreLike = Pick<ReturnType<typeof createStateStore>, "getReviewedHeadSha" | "shouldReview" | "markReviewed">;
type BuildReviewInputFn = typeof buildPullRequestReviewInput;
type ReviewPullRequestFn = typeof reviewPullRequest;

interface RunCliDependencies {
  github?: GitHubClientLike;
  workspaceManager?: WorkspaceManagerLike;
  stateStore?: StateStoreLike;
  reviewModel?: ReviewEngineModel;
  buildReviewInput?: BuildReviewInputFn;
  reviewPullRequestFn?: ReviewPullRequestFn;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, deps: RunCliDependencies = {}): Promise<void> {
  const options = resolveCliOptions(argv, env);
  const github = deps.github ?? new GitHubClient();
  const workspaceManager = deps.workspaceManager ?? new WorkspaceManager();
  const stateStore = deps.stateStore ?? createStateStore();
  const reviewModel =
    deps.reviewModel ??
    new OpenAiReviewModel({
      apiKey: env.OPENAI_API_KEY,
      model: options.model
    });
  const buildReviewInput = deps.buildReviewInput ?? buildPullRequestReviewInput;
  const reviewPullRequestImpl = deps.reviewPullRequestFn ?? reviewPullRequest;
  const stdout = deps.stdout ?? process.stdout;
  const isQueueRun = !(options.repo && options.pr !== undefined);
  const currentGitHubLogin = isQueueRun ? await github.resolveAuthenticatedLogin() : undefined;

  const pullRequests = await discoverPullRequests(github, options);
  if (pullRequests.length === 0) {
    stdout.write("No pull requests to review.\n");
    return;
  }

  await mapLimit(pullRequests, options.concurrency, async (pullRequest) => {
    const metadata = await github.getPullRequestMetadata({
      repository: pullRequest.repository,
      number: pullRequest.number
    });
    const reviewTarget = {
      host: metadata.repository.host ?? "github.com",
      owner: metadata.repository.owner,
      repo: metadata.repository.name,
      prNumber: metadata.number
    };

    if (isQueueRun && metadata.isDraft) {
      stdout.write(`Skipping ${metadata.repository.owner}/${metadata.repository.name}#${metadata.number}; pull request is draft.\n`);
      return;
    }

    const [existingReviews, shouldReview] = await Promise.all([
      github.getExistingReviews(pullRequest),
      stateStore.shouldReview(reviewTarget, metadata.headSha)
    ]);

    if (isQueueRun && currentGitHubLogin) {
      const hasReviewFromCurrentUser = hasReviewFromAuthor(existingReviews, currentGitHubLogin);
      if (hasReviewFromCurrentUser) {
        stdout.write(
          `Skipping ${metadata.repository.owner}/${metadata.repository.name}#${metadata.number}; already reviewed by GitHub user ${currentGitHubLogin}.\n`
        );
        return;
      }
    }

    const skipMetadata = github.buildSkipMetadata(metadata.headSha, existingReviews);
    if (skipMetadata.alreadyReviewedCurrentHead || !shouldReview) {
      stdout.write(`Skipping ${metadata.repository.owner}/${metadata.repository.name}#${metadata.number}; current head already reviewed.\n`);
      return;
    }

    const diff = await github.getPullRequestDiff(pullRequest);
    await workspaceManager.withWorkspace(metadata, async (workspace) => {
      const reviewInput = await buildReviewInput({
        repoDir: workspace.repoDir,
        metadata,
        diff,
        maxFiles: options.maxFiles,
        maxLines: options.maxLines
      });
      const result = await reviewPullRequestImpl(
        {
          ...reviewInput,
          reviewLevel: options.reviewLevel,
        },
        reviewModel,
      );
      const submission = await github.submitReview({
        pullRequest,
        headSha: metadata.headSha,
        diff,
        summary: formatSummary(result),
        verdict: result.summary.verdict,
        findings: result.findings.map((finding) => ({
          path: finding.path,
          line: finding.line ?? undefined,
          severity: finding.severity,
          title: finding.title,
          body: finding.body,
          category: finding.category
        })),
        dryRun: options.dryRun
      });

      if (options.dryRun) {
        stdout.write(`${JSON.stringify(submission.payloads, null, 2)}\n`);
      } else {
        await stateStore.markReviewed(reviewTarget, metadata.headSha);
      }

      stdout.write(
        `${metadata.repository.owner}/${metadata.repository.name}#${metadata.number}: ${result.summary.verdict} (${result.findings.length} findings)\n`
      );
    });
  });
}

async function discoverPullRequests(
  github: GitHubClientLike,
  options: ReturnType<typeof resolveCliOptions>
): Promise<PullRequestCandidate[]> {
  if (options.repo && options.pr !== undefined) {
    return [
      {
        repository: {
          owner: options.repo.owner,
          name: options.repo.repo,
          host: options.repo.host
        },
        number: options.pr,
        title: "",
        url: ""
      }
    ];
  }

  return github.discoverPullRequests({
    org: options.org,
    repo: options.repo ? `${options.repo.owner}/${options.repo.repo}` : undefined
  });
}

function hasReviewFromAuthor(reviews: ExistingReviewSummary[], authorLogin: string): boolean {
  const expected = authorLogin.trim().toLowerCase();
  return reviews.some((review) => review.authorLogin?.trim().toLowerCase() === expected);
}

function formatSummary(result: Awaited<ReturnType<typeof reviewPullRequest>>): string {
  const counts = result.summary.severityCounts;
  const topRisks = result.summary.topRisks.length > 0
    ? `Top risks:\n${result.summary.topRisks.map((risk) => `- ${risk}`).join("\n")}`
    : undefined;

  return [
    result.summary.summary,
    `Coverage: ${result.summary.coverageNote}`,
    `Severity counts: critical=${counts.critical}, major=${counts.major}, minor=${counts.minor}, nitpick=${counts.nitpick}`,
    topRisks
  ].filter(Boolean).join("\n\n");
}

async function mapLimit<T>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<void>
): Promise<void> {
  const queue = [...values];
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) {
        await worker(next);
      }
    }
  });
  await Promise.all(runners);
}
