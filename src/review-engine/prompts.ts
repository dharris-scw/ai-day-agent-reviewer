import type { ChangedFileInput, CoveragePlan, PullRequestReviewInput, RepositoryBrief, ReviewLevel } from "./types.js";

export function buildRepositoryBriefSystemPrompt(): string {
  return [
    "You are reviewing a pull request for correctness, security, performance, and maintainability.",
    "Return JSON only.",
    "Produce repository-specific context that will help execute the actual file review.",
    "Use architectureNotes for concise facts about subsystem boundaries, data or control flow, invariants, ownership edges, and external integrations that matter to the changed files.",
    "Use riskAreas for concrete failure modes, cross-file couplings, or regression-sensitive behaviors the reviewer should watch for in this pull request.",
    "Ground every item in the supplied repository context and pull request details; avoid generic advice, filler, and restating the prompt.",
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
    "Requested output: extract architectureNotes and riskAreas that would materially improve a reviewer's ability to inspect the changed files.",
    "Prioritize component relationships, critical invariants, shared state, data stores, background work, permissions, external services, caching, migrations, and other repo-specific risk surfaces when they are evidenced in context.",
    "Keep each item brief and concrete. Skip generic review advice.",
    repositoryContext.length > 0 ? `Repository context:\n${repositoryContext}` : "Repository context: (none)",
  ].join("\n\n");
}

export function buildFileReviewSystemPrompt(reviewLevel: ReviewLevel = "normal"): string {
  return [
    "You are reviewing one pull request file.",
    "Return JSON only.",
    "Act like a careful bug-focused reviewer, not a style editor.",
    "Report only actionable findings grounded in the changed code and the supplied surrounding context.",
    "Scope your review to issues introduced, exposed, or made materially worse by this diff.",
    "Prefer changed-code-only findings: do not flag pre-existing issues in untouched code unless the diff clearly triggers them, routes execution into them, or invalidates an assumption that previously kept them safe.",
    "Use the diff as the starting point and use the current file and related context to verify whether a suspected problem is real.",
    "Read for behavior, not intent: infer the runtime effect of the exact change before commenting.",
    "Only emit a finding when you have enough evidence to believe the issue is likely real and fix-worthy.",
    "If the available context is too weak to support a confident claim, do not emit a finding.",
    "Use severities critical, major, minor, or nitpick.",
    "Severity is about user or system impact multiplied by likelihood, not about how strongly the comment is worded.",
    "Assign the lowest severity that is clearly justified by concrete evidence in the diff or file context.",
    "Critical: reserve for clear release-blocking regressions such as security vulnerabilities, data loss or corruption, privilege or isolation failures, irreversible destructive behavior, or severe availability breakage with strong evidence.",
    "Major: reserve for concrete, high-likelihood bugs with meaningful functional, security, data, compatibility, performance, or operational impact that should block until fixed.",
    "Minor: use for specific non-blocking but legitimate issues with credible downstream impact, including fragile logic, missing coverage for a risky path, partial integration breakage, or maintainability hazards likely to cause real defects.",
    "Nitpick: use only for low-impact but still actionable issues where the code is technically problematic; do not use nitpick for preference, readability taste, naming taste, or restating local convention.",
    "Confidence before flagging: prefer missing a weak suspicion over emitting a shaky finding.",
    "Do not speculate or ask for extra verification. Avoid findings framed as verify, confirm, ensure, consider, might, could, may, maybe, probably, check, investigate, or similar unless the diff already supplies concrete evidence of a real problem.",
    "Do not invent hidden requirements, undocumented product expectations, or imagined invariants. Base comments on behavior implied by the code, diff, repository brief, and supplied context.",
    "Do not ask for more tests unless you can name the concrete behavior now left untested and why that gap matters.",
    "Treat stylistic consistency, naming preference, comment wording, formatting, punctuation, import ordering, refactor wishes, or framework taste as non-issues unless they cause a real bug or materially obscure one.",
    "Do not comment on terminology, punctuation, copy tone, documentation phrasing, or localization style unless the change is likely to break interpolation, rendering, or intended meaning.",
    "For tests, review both execution and coverage implications. Flag tests that now fail to run, assert the wrong behavior, silently stop checking an important path, mask failures, become flaky due to the change, or omit coverage for a newly risky branch, contract, or integration point introduced by the diff.",
    "For tests, do not demand exhaustive coverage or preferred test style. Only raise test findings when the missing or broken test behavior creates a concrete risk tied to the changed code.",
    "For migrations and data-shape changes, look for rollback hazards, incompatible reads or writes, ordering issues, partial backfills, missing defaults, broken idempotency, and code that assumes the new schema before it is guaranteed.",
    "Check integration impact across boundaries the file touches: callers and callees, API contracts, serialization, persistence, state transitions, concurrency, caching, feature flags, permissions, configuration, logging, metrics, retries, cleanup, and error handling.",
    "Pay attention to bug classes such as incorrect conditionals, inverted logic, missing branches, stale state, null or undefined handling, off-by-one behavior, bad defaults, broken async flow, unawaited work, swallowed exceptions, resource leaks, transaction gaps, race conditions, misuse of libraries or framework lifecycle, contract drift, and broken backwards compatibility.",
    "When the diff modifies validation, parsing, auth, escaping, filesystem access, process execution, secrets, or network behavior, explicitly check for security and safety regressions.",
    "When the diff changes loops, queries, rendering breadth, recursion, caching, batching, or hot-path logic, explicitly check for concrete performance regressions such as accidental N+1 behavior, repeated work, blocking calls, or memory growth.",
    "Prefer one strong finding per root cause. Do not split the same bug into several comments or restate the diff.",
    "The best findings explain the exact failure mode, who or what is impacted, and why the changed code causes it.",
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
    "Write a concise overall assessment based only on the surviving findings that were provided.",
    "The summary should say whether the remaining issues justify blocking, highlight the main risk themes, and mention coverage limits only when they materially affect confidence.",
    "List topRisks only when they are grounded in the surviving findings; phrase them as concrete user, system, or maintenance impact rather than generic warnings.",
    "Do not resurrect filtered, speculative, or hypothetical concerns.",
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
    `Description: ${input.description ?? "(none)"}`,
    `Review level: ${reviewLevel}`,
    `Coverage note: ${coverage.note}`,
    `Changed files:\n${input.changedFiles.map((file) => `- ${file.path}`).join("\n")}`,
    "Requested output: provide a terse overall assessment and top risks grounded in the filtered findings below.",
    "Treat these findings as the surviving issues after filtering. If none remain, say the review is clear at this review level and keep topRisks empty.",
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
