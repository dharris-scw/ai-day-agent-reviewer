import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { PullRequestMetadata, SubmitReviewResult } from "../../src/github/types.js";
import type { ReviewResult } from "../../src/review-engine/types.js";
import {
  buildAndWriteDryRunArtifact,
  buildDryRunArtifact,
  buildDryRunReviewArtifact,
  formatDryRunArtifactTimestamp,
  getDryRunArtifactFilename,
  slugArtifactSegment,
} from "../../src/cli/dry-run-artifact.js";

function createMetadata(
  overrides: Partial<PullRequestMetadata> = {},
): PullRequestMetadata {
  return {
    repository: {
      owner: "acme-inc",
      name: "widget.api",
      host: "github.example.com",
    },
    number: 42,
    title: "Tighten validation around dry runs",
    url: "https://github.example.com/acme-inc/widget.api/pull/42",
    body: "Adds validation and reporting improvements.",
    baseRefName: "main",
    headRefName: "feature/dry-run-artifacts",
    baseSha: "base-sha-123",
    headSha: "head-sha-456",
    changedFiles: [],
    isDraft: false,
    ...overrides,
  };
}

function createReviewResult(findingsCount = 2): ReviewResult {
  return {
    coverage: {
      mode: "full",
      note: "Reviewed all changed files.",
      reviewedPaths: ["src/main.ts"],
      skippedPaths: [],
      totalFiles: 1,
      totalChangedLines: 12,
    },
    findings: Array.from({ length: findingsCount }, (_, index) => ({
      path: "src/main.ts",
      line: index + 27,
      severity: index === 0 ? "major" as const : "minor" as const,
      title: `Finding ${index + 1}`,
      body: `Body ${index + 1}`,
      category: "maintainability",
    })),
    summary: {
      verdict: "REQUEST_CHANGES",
      summary: "Dry-run mode should write artifacts instead of printing payloads.",
      coverageNote: "Reviewed all changed files.",
      topRisks: ["Dry-run output remains noisy and hard to consume in automation."],
      severityCounts: {
        critical: 0,
        major: findingsCount > 0 ? 1 : 0,
        minor: findingsCount > 1 ? findingsCount - 1 : 0,
        nitpick: 0,
      },
    },
  };
}

function createSubmission(metadata: PullRequestMetadata): SubmitReviewResult {
  return {
    dryRun: true,
    payloads: [
      {
        method: "POST",
        endpoint: `repos/${metadata.repository.owner}/${metadata.repository.name}/pulls/${metadata.number}/reviews`,
        body: {
          event: "REQUEST_CHANGES",
          body: "Dry-run mode should write artifacts instead of printing payloads.",
        },
      },
    ],
  };
}

test("formatDryRunArtifactTimestamp uses sortable UTC timestamps", () => {
  assert.equal(formatDryRunArtifactTimestamp("2026-06-12T03:14:15.016Z"), "20260612-031415-016");
});

test("slugArtifactSegment keeps allowed filename characters and normalizes the rest", () => {
  assert.equal(slugArtifactSegment(" Acme Org/widget repo "), "Acme-Org-widget-repo");
  assert.equal(slugArtifactSegment("..."), "...");
  assert.equal(slugArtifactSegment("///"), "unknown");
});

test("getDryRunArtifactFilename uses a single timestamped aggregate name", () => {
  assert.equal(
    getDryRunArtifactFilename("2026-06-12T03:14:15.016Z"),
    "agent-review-dry-run-20260612-031415-016.json",
  );
});

test("buildDryRunReviewArtifact returns one review entry", () => {
  const metadata = createMetadata();
  const review = buildDryRunReviewArtifact({
    metadata,
    reviewLevel: "deep",
    result: createReviewResult(),
    submission: createSubmission(metadata),
  });

  assert.deepEqual(review.pullRequest, {
    host: "github.example.com",
    owner: "acme-inc",
    repo: "widget.api",
    number: 42,
    title: "Tighten validation around dry runs",
    url: "https://github.example.com/acme-inc/widget.api/pull/42",
    baseSha: "base-sha-123",
    headSha: "head-sha-456",
  });
  assert.equal(review.review.reviewLevel, "deep");
  assert.equal(review.review.findingsCount, 2);
  assert.equal(review.submission.payloads.length, 1);
});

test("buildDryRunReviewArtifact rejects non-dry-run submissions", () => {
  assert.throws(
    () =>
      buildDryRunReviewArtifact({
        metadata: createMetadata(),
        reviewLevel: "normal",
        result: createReviewResult(),
        submission: {
          dryRun: false,
          payloads: [],
        },
      }),
    /Dry-run artifacts can only be created from dry-run submissions/,
  );
});

test("buildDryRunArtifact aggregates multiple reviews", () => {
  const first = createMetadata();
  const second = createMetadata({
    repository: {
      owner: "acme-inc",
      name: "gadget.api",
      host: "github.example.com",
    },
    number: 7,
    title: "Second review",
    url: "https://github.example.com/acme-inc/gadget.api/pull/7",
  });

  const artifact = buildDryRunArtifact({
    reviews: [
      buildDryRunReviewArtifact({
        metadata: first,
        reviewLevel: "deep",
        result: createReviewResult(2),
        submission: createSubmission(first),
      }),
      buildDryRunReviewArtifact({
        metadata: second,
        reviewLevel: "normal",
        result: createReviewResult(1),
        submission: createSubmission(second),
      }),
    ],
    generatedAt: "2026-06-12T03:14:15.016Z",
  });

  assert.equal(artifact.generatedAt, "2026-06-12T03:14:15.016Z");
  assert.equal(artifact.mode, "dry-run");
  assert.equal(artifact.reviewCount, 2);
  assert.equal(artifact.reviews[0]?.pullRequest.number, 42);
  assert.equal(artifact.reviews[1]?.pullRequest.number, 7);
});

test("buildAndWriteDryRunArtifact writes one valid aggregate JSON file in the repo root", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-review-artifact-"));
  const metadata = createMetadata();

  const result = await buildAndWriteDryRunArtifact({
    reviews: [
      buildDryRunReviewArtifact({
        metadata,
        reviewLevel: "normal",
        result: createReviewResult(),
        submission: createSubmission(metadata),
      }),
    ],
    generatedAt: "2026-06-12T03:14:15.016Z",
    repoRoot,
  });

  assert.equal(
    basename(result.path),
    "agent-review-dry-run-20260612-031415-016.json",
  );
  assert.equal(result.filename, basename(result.path));

  const raw = await readFile(result.path, "utf8");
  const parsed = JSON.parse(raw);

  assert.equal(parsed.mode, "dry-run");
  assert.equal(parsed.reviewCount, 1);
  assert.equal(parsed.reviews[0].pullRequest.number, 42);
  assert.equal(parsed.reviews[0].review.findingsCount, 2);
  assert.equal(parsed.reviews[0].submission.dryRun, true);
});
