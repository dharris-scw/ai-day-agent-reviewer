import { Listr, type ListrTask, type ListrTaskWrapper } from "listr2";
import {
  buildAndWriteDryRunArtifact,
  buildDryRunReviewArtifact,
  type DryRunReviewArtifact,
} from "./cli/dry-run-artifact.js";
import { createCliRenderer, type CliRenderer, type CliRenderStream } from "./cli/renderer.js";
import { resolveCliOptions } from "./cli/args.js";
import { GitHubClient } from "./github/client.js";
import type { ExistingReviewSummary, PullRequestCandidate, PullRequestMetadata } from "./github/types.js";
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
type BuildDryRunReviewArtifactFn = typeof buildDryRunReviewArtifact;
type BuildAndWriteDryRunArtifactFn = typeof buildAndWriteDryRunArtifact;

type ReviewSkipReason = "draft" | "reviewed-by-user" | "reviewed-head";

interface RunCliDependencies {
  github?: GitHubClientLike;
  workspaceManager?: WorkspaceManagerLike;
  stateStore?: StateStoreLike;
  reviewModel?: ReviewEngineModel;
  buildReviewInput?: BuildReviewInputFn;
  reviewPullRequestFn?: ReviewPullRequestFn;
  buildDryRunReviewArtifactFn?: BuildDryRunReviewArtifactFn;
  buildAndWriteDryRunArtifactFn?: BuildAndWriteDryRunArtifactFn;
  stdout?: CliRenderStream;
  renderer?: CliRenderer;
  cwd?: string;
  now?: () => Date;
}

interface RunCliServices {
  github: GitHubClientLike;
  workspaceManager: WorkspaceManagerLike;
  stateStore: StateStoreLike;
  reviewModel: ReviewEngineModel;
  buildReviewInput: BuildReviewInputFn;
  reviewPullRequestImpl: ReviewPullRequestFn;
  buildDryRunReviewArtifactImpl: BuildDryRunReviewArtifactFn;
  buildAndWriteDryRunArtifactImpl: BuildAndWriteDryRunArtifactFn;
  cwd: string;
  now: () => Date;
}

interface ProcessPullRequestInput {
  pullRequest: PullRequestCandidate;
  options: ReturnType<typeof resolveCliOptions>;
  services: RunCliServices;
  isQueueRun: boolean;
  currentGitHubLogin?: string;
  onReviewing(label: string): void;
  onSkip(label: string, reason: ReviewSkipReason): void;
  onComplete(result: {
    label: string;
    findingsCount: number;
    message: string;
    dryRunReviewArtifact?: DryRunReviewArtifact;
  }): void;
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, deps: RunCliDependencies = {}): Promise<void> {
  const options = resolveCliOptions(argv, env);
  const services: RunCliServices = {
    github: deps.github ?? new GitHubClient(),
    workspaceManager: deps.workspaceManager ?? new WorkspaceManager(),
    stateStore: deps.stateStore ?? createStateStore(),
    reviewModel:
      deps.reviewModel ??
      new OpenAiReviewModel({
        apiKey: env.OPENAI_API_KEY,
        model: options.model
      }),
    buildReviewInput: deps.buildReviewInput ?? buildPullRequestReviewInput,
    reviewPullRequestImpl: deps.reviewPullRequestFn ?? reviewPullRequest,
    buildDryRunReviewArtifactImpl:
      deps.buildDryRunReviewArtifactFn ?? buildDryRunReviewArtifact,
    buildAndWriteDryRunArtifactImpl:
      deps.buildAndWriteDryRunArtifactFn ?? buildAndWriteDryRunArtifact,
    cwd: deps.cwd ?? process.cwd(),
    now: deps.now ?? (() => new Date()),
  };

  const stdout = deps.stdout ?? process.stdout;
  const isQueueRun = !(options.repo && options.pr !== undefined);
  const currentGitHubLogin = isQueueRun ? await services.github.resolveAuthenticatedLogin() : undefined;

  const pullRequests = await discoverPullRequests(services.github, options);
  if (pullRequests.length === 0) {
    stdout.write("No pull requests to review.\n");
    return;
  }

  if (stdout.isTTY && !deps.renderer) {
    await runCliWithListr({
      pullRequests,
      options,
      services,
      isQueueRun,
      currentGitHubLogin,
    });
    return;
  }

  const renderer = deps.renderer ?? createCliRenderer({ output: stdout });
  const spinnerLabel = isQueueRun ? "Reviewing pull requests" : `Reviewing ${formatPullRequestLabel(pullRequests[0])}`;
  const dryRunReviews = new Map<string, DryRunReviewArtifact>();

  renderer.setSpinnerLabel(spinnerLabel);
  for (const pullRequest of pullRequests) {
    renderer.upsertTask({
      id: getPullRequestKey(pullRequest),
      label: formatPullRequestLabel(pullRequest),
      status: "queued",
    });
  }

  try {
    await mapLimit(pullRequests, options.concurrency, async (pullRequest) => {
      const taskId = getPullRequestKey(pullRequest);

      await processPullRequest({
        pullRequest,
        options,
        services,
        isQueueRun,
        currentGitHubLogin,
        onReviewing(label) {
          renderer.upsertTask({
            id: taskId,
            label,
            status: "reviewing",
          });
        },
        onSkip(label, reason) {
          renderer.upsertTask({
            id: taskId,
            label,
            status: "skipped",
            message: describeSkipReason(reason),
          });
        },
        onComplete(result) {
          if (result.dryRunReviewArtifact) {
            dryRunReviews.set(taskId, result.dryRunReviewArtifact);
          }
          renderer.upsertTask({
            id: taskId,
            label: result.label,
            status: "complete",
            findingsCount: result.findingsCount,
            message: result.message,
          });
        },
      });
    });
  } finally {
    renderer.stop();
  }

  await writeFinalDryRunArtifactIfNeeded({
    pullRequests,
    options,
    services,
    stdout,
    dryRunReviews,
  });
}

async function runCliWithListr(args: {
  pullRequests: PullRequestCandidate[];
  options: ReturnType<typeof resolveCliOptions>;
  services: RunCliServices;
  isQueueRun: boolean;
  currentGitHubLogin?: string;
}): Promise<void> {
  const dryRunReviews = new Map<string, DryRunReviewArtifact>();
  const tasks: ListrTask[] = args.pullRequests.map((pullRequest) => ({
    title: formatPullRequestLabel(pullRequest),
    task: async (_ctx: unknown, task: ListrTaskWrapper<unknown, any, any>) => {
      const taskId = getPullRequestKey(pullRequest);
      await processPullRequest({
        pullRequest,
        options: args.options,
        services: args.services,
        isQueueRun: args.isQueueRun,
        currentGitHubLogin: args.currentGitHubLogin,
        onReviewing(label) {
          task.title = label;
        },
        onSkip(label, reason) {
          task.title = label;
          task.skip(describeSkipReason(reason));
        },
        onComplete(result) {
          if (result.dryRunReviewArtifact) {
            dryRunReviews.set(taskId, result.dryRunReviewArtifact);
          }
          task.title = appendFindingsSuffix(result.label, result.findingsCount);
          task.output = result.message;
        },
      });
    },
  }));

  const listr = new Listr(tasks, {
    concurrent: args.options.concurrency,
    exitOnError: true,
    registerSignalListeners: false,
    rendererOptions: {
      showSubtasks: false,
      collapseErrors: false,
      collapseSkips: false,
    },
  });

  await listr.run();

  await writeFinalDryRunArtifactIfNeeded({
    pullRequests: args.pullRequests,
    options: args.options,
    services: args.services,
    stdout: process.stdout,
    dryRunReviews,
  });
}

async function processPullRequest({
  pullRequest,
  options,
  services,
  isQueueRun,
  currentGitHubLogin,
  onReviewing,
  onSkip,
  onComplete,
}: ProcessPullRequestInput): Promise<void> {
  onReviewing(formatPullRequestLabel(pullRequest));

  const metadata = await services.github.getPullRequestMetadata({
    repository: pullRequest.repository,
    number: pullRequest.number
  });
  const label = formatPullRequestLabel(metadata);
  onReviewing(label);

  const reviewTarget = {
    host: metadata.repository.host ?? "github.com",
    owner: metadata.repository.owner,
    repo: metadata.repository.name,
    prNumber: metadata.number
  };

  if (isQueueRun && metadata.isDraft) {
    onSkip(label, "draft");
    return;
  }

  const [existingReviews, shouldReview] = await Promise.all([
    services.github.getExistingReviews(pullRequest),
    services.stateStore.shouldReview(reviewTarget, metadata.headSha)
  ]);

  if (isQueueRun && currentGitHubLogin) {
    const hasReviewFromCurrentUser = hasReviewFromAuthor(existingReviews, currentGitHubLogin);
    if (hasReviewFromCurrentUser) {
      onSkip(label, "reviewed-by-user");
      return;
    }
  }

  const skipMetadata = services.github.buildSkipMetadata(metadata.headSha, existingReviews);
  if (skipMetadata.alreadyReviewedCurrentHead || !shouldReview) {
    onSkip(label, "reviewed-head");
    return;
  }

  const diff = await services.github.getPullRequestDiff(pullRequest);
  await services.workspaceManager.withWorkspace(metadata, async (workspace) => {
    const reviewInput = await services.buildReviewInput({
      repoDir: workspace.repoDir,
      metadata,
      diff,
      maxFiles: options.maxFiles,
      maxLines: options.maxLines
    });
    const result = await services.reviewPullRequestImpl(
      {
        ...reviewInput,
        reviewLevel: options.reviewLevel,
      },
      services.reviewModel,
    );
    const submission = await services.github.submitReview({
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

    const completionMessage = result.summary.verdict;
    let dryRunReviewArtifact: DryRunReviewArtifact | undefined;

    if (options.dryRun) {
      dryRunReviewArtifact = services.buildDryRunReviewArtifactImpl({
        metadata,
        reviewLevel: options.reviewLevel,
        result,
        submission,
      });
    } else {
      await services.stateStore.markReviewed(reviewTarget, metadata.headSha);
    }

    onComplete({
      label,
      findingsCount: result.findings.length,
      message: completionMessage,
      dryRunReviewArtifact,
    });
  });
}

async function writeFinalDryRunArtifactIfNeeded(args: {
  pullRequests: PullRequestCandidate[];
  options: ReturnType<typeof resolveCliOptions>;
  services: RunCliServices;
  stdout: CliRenderStream;
  dryRunReviews: Map<string, DryRunReviewArtifact>;
}): Promise<void> {
  if (!args.options.dryRun || args.dryRunReviews.size === 0) {
    return;
  }

  const reviews = args.pullRequests
    .map((pullRequest) => args.dryRunReviews.get(getPullRequestKey(pullRequest)))
    .filter((review): review is DryRunReviewArtifact => review !== undefined);

  const artifact = await args.services.buildAndWriteDryRunArtifactImpl({
    reviews,
    generatedAt: args.services.now(),
    repoRoot: args.services.cwd,
  });

  args.stdout.write(`findings written to ${artifact.path}\n`);
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

function getPullRequestKey(
  pullRequest: Pick<PullRequestCandidate, "number" | "repository">,
): string {
  return `${pullRequest.repository.owner}/${pullRequest.repository.name}#${pullRequest.number}`;
}

function formatPullRequestLabel(
  pullRequest: Pick<PullRequestCandidate, "number" | "repository" | "title"> | PullRequestMetadata,
): string {
  const suffix = `[${pullRequest.repository.name}#${pullRequest.number}]`;
  const title = pullRequest.title.trim();
  return title ? `${title} ${suffix}` : getPullRequestKey(pullRequest);
}

function describeSkipReason(reason: ReviewSkipReason): string {
  switch (reason) {
    case "draft":
      return "draft";
    case "reviewed-by-user":
      return "already reviewed by current user";
    case "reviewed-head":
      return "current head already reviewed";
    default: {
      const exhaustiveCheck: never = reason;
      return exhaustiveCheck;
    }
  }
}

function appendFindingsSuffix(label: string, findingsCount: number): string {
  const count = Math.max(0, Math.trunc(findingsCount));
  const noun = count === 1 ? "finding" : "findings";
  return `${label} (${count} ${noun})`;
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
