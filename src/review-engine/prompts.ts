import type { ChangedFileInput, CoveragePlan, PullRequestReviewInput, RepositoryBrief, ReviewLevel } from "./types.js";

export function buildRepositoryBriefSystemPrompt(): string {
  return [
    "You are reviewing a pull request for correctness, security, performance, and maintainability.",
    "Return JSON only.",
    "Summarize architecture and likely risk areas from the supplied repository context.",
  ].join(" ");
}

export function buildRepositoryBriefUserPrompt(input: PullRequestReviewInput, coverage: CoveragePlan): string {
  const repositoryContext = (input.repositoryContext ?? [])
    .slice(0, 12)
    .map((file) => `FILE: ${file.path}\n${truncate(file.content, 4000)}`)
    .join("\n\n");

  return [
    `Repository: ${input.owner}/${input.repo}`,
    `Pull request: ${input.title}`,
    `Description: ${input.description ?? "(none)"}`,
    `Coverage plan: ${coverage.note}`,
    `Changed files:\n${input.changedFiles.map((file) => `- ${file.path}`).join("\n")}`,
    repositoryContext.length > 0 ? `Repository context:\n${repositoryContext}` : "Repository context: (none)",
  ].join("\n\n");
}

export function buildFileReviewSystemPrompt(reviewLevel: ReviewLevel = "normal"): string {
  return [
    "You are reviewing one pull request file.",
    "Return JSON only.",
    "Report only actionable findings grounded in the diff and surrounding context.",
    "Use severities critical, major, minor, or nitpick.",
    "Assign the lowest severity that is clearly justified by concrete evidence in the diff or file context.",
    "Critical: reserve for clear release-blocking correctness, security, data-loss, or availability regressions with strong evidence.",
    "Major: reserve for concrete, high-likelihood issues with meaningful user, correctness, performance, or maintenance impact that should block until fixed.",
    "Minor: use for specific non-blocking issues with credible impact; do not use minor for vague risks, preferences, or hypothetical follow-up checks.",
    "Nitpick: use only for low-impact but still actionable issues; skip it when the point is mostly style, taste, or restating team preference.",
    "Do not speculate or ask for extra verification. Avoid findings framed as verify, confirm, ensure, consider, might, could, check, or similar unless the diff provides concrete evidence of a real problem or likely regression.",
    "Do not comment on terminology, punctuation, copy tone, documentation phrasing, or localization style unless the change is likely to break interpolation, rendering, or intended meaning.",
    "For tests and migrations, emit comments only when they are concrete, actionable, and tied to a real failure mode shown in the diff or file context.",
    "Treat suggestions to replace co, standardize expect versus should, clean imports or comments, modernize async style, or improve consistency or readability as non-blocking noise unless the diff shows a concrete failure.",
    "Only raise test or migration findings for concrete breakages such as tests not executing, undefined references or imports, empty catches hiding failures, truncated tests, broken runner structure, false-positive assertions, or critical suites no longer running.",
    describeReviewLevel(reviewLevel),
  ].join(" ");
}

export function buildFileReviewUserPrompt(
  file: ChangedFileInput,
  coverage: CoveragePlan,
  repositoryBrief: RepositoryBrief,
  reviewLevel: ReviewLevel = "normal",
): string {
  return [
    `Review level: ${reviewLevel}`,
    `Coverage: ${coverage.note}`,
    `Architecture notes:\n${repositoryBrief.architectureNotes.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `Risk areas:\n${repositoryBrief.riskAreas.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `Path: ${file.path}`,
    file.context ? `Related context:\n${truncate(file.context, 2000)}` : "Related context: (none)",
    `Diff:\n${truncate(file.patch, 6000)}`,
    `Current file:\n${truncate(file.content, 12000)}`,
  ].join("\n\n");
}

export function buildSynthesisSystemPrompt(reviewLevel: ReviewLevel = "normal"): string {
  return [
    "You are synthesizing a pull request review.",
    "Return JSON only.",
    "Summarize the overall review, mention coverage limits when relevant, and list top risks.",
    `The findings have already been filtered for a ${reviewLevel} review.`,
  ].join(" ");
}

export function buildSynthesisUserPrompt(
  input: PullRequestReviewInput,
  coverage: CoveragePlan,
  reviewLevel: ReviewLevel,
  findingsText: string,
): string {
  return [
    `Repository: ${input.owner}/${input.repo}`,
    `Pull request: ${input.title}`,
    `Review level: ${reviewLevel}`,
    `Coverage note: ${coverage.note}`,
    `Filtered findings:\n${findingsText || "- no findings at this review level"}`,
  ].join("\n\n");
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

function describeReviewLevel(reviewLevel: ReviewLevel): string {
  switch (reviewLevel) {
    case "light":
      return "Light review: surface only critical or major issues when they are clearly evidenced and worth blocking on; skip minor and nitpick feedback.";
    case "deep":
      return "Deep review: inspect broadly, but stay conservative; report actionable issues only when they are specific, defensible, and supported by the diff or context, including minor and nitpick findings when they are worth the author's time.";
    case "normal":
    default:
      return "Normal review: report clearly evidenced critical, major, and minor issues; skip nitpicks unless they hide a broader concrete actionable risk.";
  }
}
