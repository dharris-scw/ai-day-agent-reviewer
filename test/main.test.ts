import test from "node:test";
import assert from "node:assert/strict";

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

function createCandidate(): PullRequestCandidate {
  return {
    repository: {
      owner: "acme",
      name: "widget",
      host: "github.com",
    },
    number: 42,
    title: "Example",
    url: "https://github.com/acme/widget/pull/42",
  };
}

function createMetadata(overrides: Partial<PullRequestMetadata> = {}): PullRequestMetadata {
  const candidate = createCandidate();
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

function createReviewResult(): ReviewResult {
  return {
    coverage: {
      mode: "full",
      note: "Full coverage.",
      reviewedPaths: [],
      skippedPaths: [],
      totalFiles: 0,
      totalChangedLines: 0,
    },
    findings: [],
    summary: {
      verdict: "COMMENT",
      summary: "No blocking issues found.",
      coverageNote: "Full coverage.",
      topRisks: [],
      severityCounts: {
        critical: 0,
        major: 0,
        minor: 0,
        nitpick: 0,
      },
    },
  };
}

function createSubmission(): SubmitReviewResult {
  return {
    dryRun: true,
    payloads: [
      {
        method: "POST",
        endpoint: "repos/acme/widget/pulls/42/reviews",
        body: { event: "COMMENT" },
      } satisfies PreparedReviewPayload,
    ],
  };
}

function createStdout() {
  const chunks: string[] = [];
  return {
    stdout: {
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

test("queue discovery skips draft pull requests", async () => {
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
      return createMetadata({ isDraft: true });
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

  assert.match(output(), /Skipping acme\/widget#42; pull request is draft\./);
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
      return createMetadata();
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

  assert.match(output(), /Skipping acme\/widget#42; already reviewed by GitHub user Reviewer\./);
});

test("explicit repo and pr targeting still reviews old draft or already-reviewed pull requests", async () => {
  const candidate = createCandidate();
  const metadata = createMetadata({ isDraft: true });
  const { stdout, output } = createStdout();

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
      return createSubmission();
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
  });

  assert.equal(resolvedGitHubLogin, false);
  assert.equal(workspaceUsed, true);
  assert.equal(diffRequested, true);
  assert.equal(reviewSubmitted, true);
  assert.match(output(), /acme\/widget#42: COMMENT \(0 findings\)/);
  assert.doesNotMatch(output(), /Skipping acme\/widget#42;/);
});
