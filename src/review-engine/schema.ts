import { buildReviewSummary, dedupeFindings as dedupeNormalizedFindings, normalizeFinding, selectVerdict } from "./normalize.js";
import type { FileReviewModelResponse, ReviewFinding, ReviewSeverity } from "./types.js";
import { fileReviewSchema, validateFileReview } from "./validation.js";

export interface RawModelReview {
  findings: Array<{
    path: string;
    line?: number | null;
    severity: ReviewSeverity | string;
    title: string;
    body: string;
    category: string;
  }>;
}

export const reviewOutputSchema = {
  name: "agent_review_findings",
  strict: true,
  schema: fileReviewSchema
} as const;

export function normalizeFindings(raw: RawModelReview): ReviewFinding[] {
  return raw.findings.map((finding) =>
    normalizeFinding({
      path: finding.path,
      line: finding.line ?? null,
      severity: finding.severity as ReviewFinding["severity"],
      title: finding.title,
      body: finding.body,
      category: finding.category
    })
  );
}

export function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return dedupeNormalizedFindings(findings);
}

export function determineVerdict(findings: ReviewFinding[]) {
  return selectVerdict(findings);
}

export function buildSummary(findings: ReviewFinding[], coverageNote?: string) {
  const summary = buildReviewSummary(
    findings,
    findings.length === 0 ? "No blocking issues found." : "Review completed with findings.",
    coverageNote ?? "",
    findings
      .slice(0, 5)
      .map((finding) => `${finding.path}${finding.line ? `:${finding.line}` : ""} [${finding.severity}] ${finding.title}`)
  );

  return {
    verdict: summary.verdict,
    coverageNote: coverageNote ?? undefined,
    totals: summary.severityCounts,
    body: [
      `Verdict: ${summary.verdict}`,
      `Severity counts: critical=${summary.severityCounts.critical}, major=${summary.severityCounts.major}, minor=${summary.severityCounts.minor}, nitpick=${summary.severityCounts.nitpick}`,
      coverageNote ? `Coverage: ${coverageNote}` : undefined,
      findings.length === 0 ? "No blocking issues found." : `Top risks:\n${summary.topRisks.map((item) => `- ${item}`).join("\n")}`
    ]
      .filter(Boolean)
      .join("\n\n")
  };
}

export function validateRawModelReview(value: unknown): FileReviewModelResponse {
  return validateFileReview(value);
}
