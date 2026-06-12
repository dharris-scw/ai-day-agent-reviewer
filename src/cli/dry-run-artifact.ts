import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PullRequestMetadata, PreparedReviewPayload, SubmitReviewResult } from "../github/types.js";
import type { ReviewFinding, ReviewLevel, ReviewResult, ReviewSeverity, ReviewVerdict } from "../review-engine/types.js";

export interface DryRunArtifactPullRequest {
  host: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  baseSha: string;
  headSha: string;
}

export interface DryRunArtifactFinding {
  path: string;
  line: number | null;
  severity: ReviewSeverity;
  title: string;
  body: string;
  category: string;
}

export interface DryRunArtifactReview {
  reviewLevel: ReviewLevel;
  verdict: ReviewVerdict;
  summary: string;
  coverageNote: string;
  topRisks: string[];
  severityCounts: Record<ReviewSeverity, number>;
  findingsCount: number;
  findings: DryRunArtifactFinding[];
}

export interface DryRunArtifactSubmission {
  dryRun: true;
  payloads: PreparedReviewPayload[];
}

export interface DryRunReviewArtifact {
  pullRequest: DryRunArtifactPullRequest;
  review: DryRunArtifactReview;
  submission: DryRunArtifactSubmission;
}

export interface DryRunArtifact {
  generatedAt: string;
  mode: "dry-run";
  reviewCount: number;
  reviews: DryRunReviewArtifact[];
}

export interface BuildDryRunReviewArtifactInput {
  metadata: PullRequestMetadata;
  reviewLevel: ReviewLevel;
  result: ReviewResult;
  submission: SubmitReviewResult;
}

export interface BuildDryRunArtifactInput {
  reviews: DryRunReviewArtifact[];
  generatedAt?: Date | string;
}

export interface WriteDryRunArtifactInput {
  artifact: DryRunArtifact;
  repoRoot?: string;
}

export interface BuildAndWriteDryRunArtifactInput extends BuildDryRunArtifactInput {
  repoRoot?: string;
}

export interface DryRunArtifactWriteResult {
  artifact: DryRunArtifact;
  filename: string;
  path: string;
}

export function buildDryRunReviewArtifact(
  input: BuildDryRunReviewArtifactInput,
): DryRunReviewArtifact {
  if (!input.submission.dryRun) {
    throw new Error("Dry-run artifacts can only be created from dry-run submissions.");
  }

  return {
    pullRequest: {
      host: input.metadata.repository.host ?? "github.com",
      owner: input.metadata.repository.owner,
      repo: input.metadata.repository.name,
      number: input.metadata.number,
      title: input.metadata.title,
      url: input.metadata.url,
      baseSha: input.metadata.baseSha,
      headSha: input.metadata.headSha,
    },
    review: {
      reviewLevel: input.reviewLevel,
      verdict: input.result.summary.verdict,
      summary: input.result.summary.summary,
      coverageNote: input.result.summary.coverageNote,
      topRisks: [...input.result.summary.topRisks],
      severityCounts: { ...input.result.summary.severityCounts },
      findingsCount: input.result.findings.length,
      findings: input.result.findings.map(mapFinding),
    },
    submission: {
      dryRun: true,
      payloads: input.submission.payloads.map((payload) => ({
        method: payload.method,
        endpoint: payload.endpoint,
        body: { ...payload.body },
      })),
    },
  };
}

export function buildDryRunArtifact(input: BuildDryRunArtifactInput): DryRunArtifact {
  return {
    generatedAt: toIsoTimestamp(input.generatedAt),
    mode: "dry-run",
    reviewCount: input.reviews.length,
    reviews: input.reviews.map(cloneReviewArtifact),
  };
}

export async function writeDryRunArtifact(input: WriteDryRunArtifactInput): Promise<DryRunArtifactWriteResult> {
  const filename = getDryRunArtifactFilename(input.artifact.generatedAt);
  const path = resolve(input.repoRoot ?? process.cwd(), filename);
  await writeFile(path, `${JSON.stringify(input.artifact, null, 2)}\n`, "utf8");

  return {
    artifact: input.artifact,
    filename,
    path,
  };
}

export async function buildAndWriteDryRunArtifact(
  input: BuildAndWriteDryRunArtifactInput,
): Promise<DryRunArtifactWriteResult> {
  const artifact = buildDryRunArtifact(input);
  return await writeDryRunArtifact({
    artifact,
    repoRoot: input.repoRoot,
  });
}

export function getDryRunArtifactFilename(generatedAt: Date | string): string {
  const timestamp = formatDryRunArtifactTimestamp(generatedAt);
  return `agent-review-dry-run-${timestamp}.json`;
}

export function formatDryRunArtifactTimestamp(value: Date | string): string {
  const date = toDate(value);

  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");

  return `${year}${month}${day}-${hours}${minutes}${seconds}-${milliseconds}`;
}

export function slugArtifactSegment(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return slug.length > 0 ? slug : "unknown";
}

function cloneReviewArtifact(review: DryRunReviewArtifact): DryRunReviewArtifact {
  return {
    pullRequest: { ...review.pullRequest },
    review: {
      ...review.review,
      topRisks: [...review.review.topRisks],
      severityCounts: { ...review.review.severityCounts },
      findings: review.review.findings.map((finding) => ({ ...finding })),
    },
    submission: {
      dryRun: true,
      payloads: review.submission.payloads.map((payload) => ({
        method: payload.method,
        endpoint: payload.endpoint,
        body: { ...payload.body },
      })),
    },
  };
}

function mapFinding(finding: ReviewFinding): DryRunArtifactFinding {
  return {
    path: finding.path,
    line: finding.line,
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    category: finding.category,
  };
}

function toIsoTimestamp(value?: Date | string): string {
  return value ? toDate(value).toISOString() : new Date().toISOString();
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${String(value)}`);
  }
  return date;
}
