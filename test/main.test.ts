import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/main.js";
import type {
  ExistingReviewSummary,
  PreparedReviewPayload,
  PullRequestCandidate,
  PullRequestMetadata,
  PullRequestRef,
  SubmitReviewResult,
} from "../src/github/types.js";
import type { PullRequestReviewInput, ReviewEngineModel, ReviewResult } from "../src/review-engine/index.js";

const env = {
  OPENAI_API_KEY: "test-key",
  OPENAI_MODEL: "gpt-4.1-mini",
};

class StubReviewModel implements ReviewEngineModel {
  async generateStructured(): Promise<never> {
    throw new Error("generateStructured should not be called in these tests");
  }
}

function createCandidate(overrides: Partial<PullRequestCandidate> = {}): PullRequestCandidate {
  return {
    repository: {
      owner: "acme",
      name: "widget",
      host: "github.com",
    },
    number: 42,
    title: "Example",
    url: "https://github.com/acme/widget/pull/42",
    ...overrides,
  };
}

function createMetadata(
  overrides: Partial<PullRequestMetadata> = {},
  candidate: PullRequestCandidate = createCandidate(),
): PullRequestMetadata {
  return {
    repository: candidate.repository,
    number: candidate.number,
    title: candidate.title,
    url: candidate.url,
    body: "",
    baseRefName: "main",
    headRefName: "feature",
    baseSha: "base-sha",
    headSha: "head-sha",
    changedFiles: [],
    isDraft: false,
    ...overrides,
  };
}

function createSkipMetadata(overrides: Partial<{ alreadyReviewedCurrentHead: boolean }> = {}) {
  return {
    currentHeadSha: "head-sha",
    reviewedHeadShas: [],
    alreadyReviewedCurrentHead: false,
    latestReviewedAt: undefined,
    ...overrides,
  };
}

function createReviewResult(findingsCount = 0): ReviewResult {
  const findings = Array.from({ length: findingsCount }, (_, index) => ({
    path: "src/app.ts",
    line: index + 1,
    severity: "minor" as const,
    title: `Finding ${index + 1}`,
    body: `Body ${index + 1}`,
    category: "maintainability",
  }));

  return {
    coverage: {
      mode: "full",
      note: "Full coverage.",
      reviewedPaths: [],
      skippedPaths: [],
      totalFiles: 0,
      totalChangedLines: 0,
    },
    findings,
    summary: {
      verdict: "COMMENT",
      summary: findingsCount === 0 ? "No blocking issues found." : "Review completed with findings.",
      coverageNote: "Full coverage.",
      topRisks: [],
      severityCounts: {
        critical: 0,
        major: 0,
        minor: findingsCount,
        nitpick: 0,
      },
    },
  };
}

function createSubmission(candidate: PullRequestCandidate = createCandidate()): SubmitReviewResult {
  return {
    dryRun: true,
    payloads: [
      {
        method: "POST",
        endpoint: `repos/${candidate.repository.owner}/${candidate.repository.name}/pulls/${candidate.number}/reviews`,
        body: { event: "COMMENT" },
      } satisfies PreparedReviewPayload,
    ],
  };
}

function createStdout(isTTY = false) {
  const chunks: string[] = [];
  return {
    stdout: {
      isTTY,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
    output() {
      return chunks.join("");
    },
  };
}

function createWorkspaceManager() {
  return {
    async withWorkspace<T>(_metadata: PullRequestMetadata, callback: (workspace: {
      rootDir: string;
      repoDir: string;
      baseSha: string;
      headSha: string;
      cleanup(): Promise<void>;
    }) => Promise<T>) {
      return await callback({
        rootDir: "/tmp/workspace",
        repoDir: "/tmp/repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        async cleanup() {},
      });
    },
  };
}

test("queue discovery skips draft pull requests in the task list", async () => {
  const candidate = createCandidate();
  const { stdout, output } = createStdout();

  const github = {
    async resolveAuthenticatedLogin() {
      return "reviewer";
    },
    async discoverPullRequests() {
      return [candidate];
    },
    async getPullRequestMetadata() {
      return createMetadata({ isDraft: true }, candidate);
    },
    async getExistingReviews(): Promise<ExistingReviewSummary[]> {
      throw new Error("getExistingReviews should not be called for draft queue PRs");
    },
    buildSkipMetadata() {
      return createSkipMetadata();
    },
    async getPullRequestDiff() {
      throw new Error("getPullRequestDiff should not be called for skipped queue PRs");
    },
    async submitReview() {
      throw new Error("submitReview should not be called for skipped queue PRs");
    },
  };

  const stateStore = {
    async getReviewedHeadSha() {
      return undefined;
    },
    async shouldReview() {
      return true;
    },
    async markReviewed() {
      throw new Error("markReviewed should not be called for skipped queue PRs");
    },
  };

  await runCli([], env, {
    github,
    stateStore,
    reviewModel: new StubReviewModel(),
    stdout,
  });

  assert.match(output(), /\[-\] Example \[widget#42\] - draft/);
});

test("queue discovery skips pull requests already reviewed by the current GitHub user", async () => {
  const candidate = createCandidate();
  const { stdout, output } = createStdout();

  const github = {
    async resolveAuthenticatedLogin() {
      return "Reviewer";
    },
    async discoverPullRequests() {
      return [candidate];
    },
    async getPullRequestMetadata() {
      return createMetadata({}, candidate);
    },
    async getExistingReviews(): Promise<ExistingReviewSummary[]> {
      return [
        {
          id: 1,
          state: "COMMENTED",
          body: "Looks good",
          authorLogin: "reviewer",
          submittedAt: "2026-06-02T10:00:00Z",
        },
      ];
    },
    buildSkipMetadata() {
      return createSkipMetadata();
    },
    async getPullRequestDiff() {
      throw new Error("getPullRequestDiff should not be called for already-reviewed queue PRs");
    },
    async submitReview() {
      throw new Error("submitReview should not be called for already-reviewed queue PRs");
    },
  };

  const stateStore = {
    async getReviewedHeadSha() {
      return undefined;
    },
    async shouldReview() {
      return true;
    },
    async markReviewed() {
      throw new Error("markReviewed should not be called for skipped queue PRs");
    },
  };

  await runCli([], env, {
    github,
    stateStore,
    reviewModel: new StubReviewModel(),
    stdout,
  });

  assert.match(output(), /\[-\] Example \[widget#42\] - already reviewed by current user/);
});

test("queue discovery skips pull requests whose current head is already reviewed", async () => {
  const candidate = createCandidate();
  const { stdout, output } = createStdout();

  const github = {
    async resolveAuthenticatedLogin() {
      return "reviewer";
    },
    async discoverPullRequests() {
      return [candidate];
    },
    async getPullRequestMetadata() {
      return createMetadata({}, candidate);
    },
    async getExistingReviews(): Promise<ExistingReviewSummary[]> {
      return [];
    },
    buildSkipMetadata() {
      return createSkipMetadata({ alreadyReviewedCurrentHead: true });
    },
    async getPullRequestDiff() {
      throw new Error("getPullRequestDiff should not be called for already-reviewed heads");
    },
    async submitReview() {
      throw new Error("submitReview should not be called for already-reviewed heads");
    },
  };

  const stateStore = {
    async getReviewedHeadSha() {
      return undefined;
    },
    async shouldReview() {
      return false;
    },
    async markReviewed() {
      throw new Error("markReviewed should not be called for skipped queue PRs");
    },
  };

  await runCli([], env, {
    github,
    stateStore,
    reviewModel: new StubReviewModel(),
    stdout,
  });

  assert.match(output(), /\[-\] Example \[widget#42\] - current head already reviewed/);
});

test("queue discovery dry-run writes one aggregate artifact file and reports it at the end", async () => {
  const candidate = createCandidate();
  const metadata = createMetadata({}, candidate);
  const { stdout, output } = createStdout();
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-main-"));

  let diffRequested = false;
  let reviewSubmitted = false;

  const github = {
    async resolveAuthenticatedLogin() {
      return "reviewer";
    },
    async discoverPullRequests() {
      return [candidate];
    },
    async getPullRequestMetadata() {
      return metadata;
    },
    async getExistingReviews(): Promise<ExistingReviewSummary[]> {
      return [];
    },
    buildSkipMetadata() {
      return createSkipMetadata();
    },
    async getPullRequestDiff() {
      diffRequested = true;
      return "diff --git a/src/app.ts b/src/app.ts\n";
    },
    async submitReview() {
      reviewSubmitted = true;
      return createSubmission(candidate);
    },
  };

  const stateStore = {
    async getReviewedHeadSha() {
      return undefined;
    },
    async shouldReview() {
      return true;
    },
    async markReviewed() {
      throw new Error("markReviewed should not be called in dry-run mode");
    },
  };

  await runCli(["--dry-run"], env, {
    github,
    stateStore,
    workspaceManager: createWorkspaceManager(),
    reviewModel: new StubReviewModel(),
    buildReviewInput: async (): Promise<PullRequestReviewInput> => ({
      owner: "acme",
      repo: "widget",
      title: "Example",
      baseSha: "base-sha",
      headSha: "head-sha",
      changedFiles: [],
      repositoryContext: [],
    }),
    reviewPullRequestFn: async () => createReviewResult(),
    stdout,
    cwd,
    now: () => new Date("2026-06-12T03:14:15.016Z"),
  });

  assert.equal(diffRequested, true);
  assert.equal(reviewSubmitted, true);
  assert.doesNotMatch(output(), /repos\/acme\/widget\/pulls\/42\/reviews/);
  assert.match(output(), /\[x\] Example \[widget#42\] \(0 findings\) - COMMENT/);
  assert.match(output(), /findings written to .*agent-review-dry-run-20260612-031415-016\.json\n$/);

  const artifactPath = join(
    cwd,
    "agent-review-dry-run-20260612-031415-016.json",
  );
  const raw = await readFile(artifactPath, "utf8");
  const parsed = JSON.parse(raw);

  assert.equal(parsed.mode, "dry-run");
  assert.equal(parsed.reviewCount, 1);
  assert.equal(parsed.reviews[0].pullRequest.number, 42);
  assert.equal(parsed.reviews[0].review.findingsCount, 0);
  assert.equal(parsed.reviews[0].submission.dryRun, true);
});

test("explicit repo and pr targeting still reviews old draft or already-reviewed pull requests", async () => {
  const candidate = createCandidate();
  const metadata = createMetadata({ isDraft: true }, candidate);
  const { stdout, output } = createStdout();
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-explicit-"));

  let resolvedGitHubLogin = false;
  let diffRequested = false;
  let reviewSubmitted = false;
  let workspaceUsed = false;

  const github = {
    async resolveAuthenticatedLogin() {
      resolvedGitHubLogin = true;
      return "reviewer";
    },
    async discoverPullRequests(): Promise<PullRequestCandidate[]> {
      throw new Error("discoverPullRequests should not be called for explicit targeting");
    },
    async getPullRequestMetadata(pullRequest: PullRequestRef) {
      assert.equal(pullRequest.number, candidate.number);
      return metadata;
    },
    async getExistingReviews(): Promise<ExistingReviewSummary[]> {
      return [
        {
          id: 1,
          state: "COMMENTED",
          body: "Prior human review",
          authorLogin: "reviewer",
          submittedAt: "2026-06-02T10:00:00Z",
        },
      ];
    },
    buildSkipMetadata() {
      return createSkipMetadata();
    },
    async getPullRequestDiff() {
      diffRequested = true;
      return "diff --git a/src/app.ts b/src/app.ts\n";
    },
    async submitReview() {
      reviewSubmitted = true;
      return createSubmission(candidate);
    },
  };

  const stateStore = {
    async getReviewedHeadSha() {
      return undefined;
    },
    async shouldReview() {
      return true;
    },
    async markReviewed() {
      throw new Error("markReviewed should not be called in dry-run mode");
    },
  };

  const workspaceManager = {
    async withWorkspace<T>(_metadata: PullRequestMetadata, callback: (workspace: {
      rootDir: string;
      repoDir: string;
      baseSha: string;
      headSha: string;
      cleanup(): Promise<void>;
    }) => Promise<T>) {
      workspaceUsed = true;
      return await callback({
        rootDir: "/tmp/workspace",
        repoDir: "/tmp/repo",
        baseSha: "base-sha",
        headSha: "head-sha",
        async cleanup() {},
      });
    },
  };

  await runCli(["--repo", "acme/widget", "--pr", "42", "--dry-run"], env, {
    github,
    stateStore,
    workspaceManager,
    reviewModel: new StubReviewModel(),
    buildReviewInput: async (): Promise<PullRequestReviewInput> => ({
      owner: "acme",
      repo: "widget",
      title: "Example",
      baseSha: "base-sha",
      headSha: "head-sha",
      changedFiles: [],
      repositoryContext: [],
    }),
    reviewPullRequestFn: async () => createReviewResult(),
    stdout,
    cwd,
    now: () => new Date("2026-06-12T03:14:15.016Z"),
  });

  assert.equal(resolvedGitHubLogin, false);
  assert.equal(workspaceUsed, true);
  assert.equal(diffRequested, true);
  assert.equal(reviewSubmitted, true);
  assert.match(output(), /\[x\] Example \[widget#42\] \(0 findings\) - COMMENT/);
  assert.match(output(), /findings written to .*agent-review-dry-run-20260612-031415-016\.json\n$/);
  assert.doesNotMatch(output(), /\[-\] Example \[widget#42\]/);
});

test("concurrent reviews preserve discovery order in the task list", async () => {
  const first = createCandidate();
  const second = createCandidate({
    repository: {
      owner: "acme",
      name: "gadget",
      host: "github.com",
    },
    number: 7,
    title: "Second",
    url: "https://github.com/acme/gadget/pull/7",
  });
  const { stdout, output } = createStdout();
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-concurrency-"));

  const github = {
    async resolveAuthenticatedLogin() {
      return "reviewer";
    },
    async discoverPullRequests() {
      return [first, second];
    },
    async getPullRequestMetadata(pullRequest: PullRequestRef) {
      return pullRequest.number === first.number
        ? createMetadata({}, first)
        : createMetadata({}, second);
    },
    async getExistingReviews(): Promise<ExistingReviewSummary[]> {
      return [];
    },
    buildSkipMetadata() {
      return createSkipMetadata();
    },
    async getPullRequestDiff() {
      return "diff --git a/src/app.ts b/src/app.ts\n";
    },
    async submitReview(input: { pullRequest: PullRequestRef }) {
      return input.pullRequest.number === first.number
        ? createSubmission(first)
        : createSubmission(second);
    },
  };

  const stateStore = {
    async getReviewedHeadSha() {
      return undefined;
    },
    async shouldReview() {
      return true;
    },
    async markReviewed() {
      throw new Error("markReviewed should not be called in dry-run mode");
    },
  };

  await runCli(["--dry-run", "--concurrency", "2"], env, {
    github,
    stateStore,
    workspaceManager: createWorkspaceManager(),
    reviewModel: new StubReviewModel(),
    buildReviewInput: async ({ metadata }): Promise<PullRequestReviewInput> => ({
      owner: metadata.repository.owner,
      repo: metadata.repository.name,
      title: metadata.title,
      baseSha: metadata.baseSha,
      headSha: metadata.headSha,
      changedFiles: [],
      repositoryContext: [],
    }),
    reviewPullRequestFn: async (input) => {
      if (input.repo === "widget") {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        return createReviewResult(1);
      }

      return createReviewResult(2);
    },
    stdout,
    cwd,
    now: () => new Date("2026-06-12T03:14:15.016Z"),
  });

  const rendered = output();
  const finalSnapshotMatch = rendered.match(
    /\[x\] Example \[widget#42\] \(1 finding\) - COMMENT\n\[x\] Second \[gadget#7\] \(2 findings\) - COMMENT\n\nfindings written to [^\n]*agent-review-dry-run-20260612-031415-016\.json\n$/,
  );

  assert.ok(finalSnapshotMatch, rendered);

  const artifactPath = join(cwd, "agent-review-dry-run-20260612-031415-016.json");
  const raw = await readFile(artifactPath, "utf8");
  const parsed = JSON.parse(raw);

  assert.equal(parsed.reviewCount, 2);
  assert.equal(parsed.reviews[0].pullRequest.number, 42);
  assert.equal(parsed.reviews[1].pullRequest.number, 7);
});
