import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFileReviewSystemPrompt,
  buildFileReviewUserPrompt,
  buildSynthesisSystemPrompt,
  buildSynthesisUserPrompt,
} from "../../src/review-engine/prompts.js";

const coverage = {
  mode: "full" as const,
  note: "Full coverage across changed files.",
  reviewedPaths: ["src/review-engine/engine.ts"],
  skippedPaths: [],
  totalFiles: 1,
  totalChangedLines: 12,
};

const repositoryBrief = {
  architectureNotes: ["The engine synthesizes file-level findings into one review."],
  riskAreas: ["Severity thresholds and summary aggregation"],
};

function assertMatchesAll(value: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    assert.match(value, pattern);
  }
}

test("file review prompts describe the breadth for each review level", () => {
  assert.match(buildFileReviewSystemPrompt("light"), /surface only critical or major issues when they are clearly evidenced and worth blocking on/);
  assert.match(buildFileReviewSystemPrompt("normal"), /report clearly evidenced critical, major, and minor issues/);
  assert.match(buildFileReviewSystemPrompt("deep"), /including minor and nitpick findings when they are worth the author's time/);
});

test("file review system prompt makes severity calibration conservative", () => {
  const prompt = buildFileReviewSystemPrompt("normal");

  assertMatchesAll(prompt, [
    /Assign the lowest severity that is clearly justified by concrete evidence/,
    /Severity is about user or system impact multiplied by likelihood, not about how strongly the comment is worded/,
    /Critical: reserve for clear release-blocking regressions such as security vulnerabilities, data loss or corruption, privilege or isolation failures, irreversible destructive behavior, or severe availability breakage with strong evidence/,
    /Major: reserve for concrete, high-likelihood bugs with meaningful functional, security, data, compatibility, performance, or operational impact that should block until fixed/,
    /Minor: use for specific non-blocking but legitimate issues with credible downstream impact, including fragile logic, missing coverage for a risky path, partial integration breakage, or maintainability hazards likely to cause real defects/,
    /Nitpick: use only for low-impact but still actionable issues where the code is technically problematic; do not use nitpick for preference, readability taste, naming taste, or restating local convention/,
  ]);
});

test("file review system prompt confines review scope to changed code and nearby evidence", () => {
  const prompt = buildFileReviewSystemPrompt("normal");

  assertMatchesAll(prompt, [
    /Report only actionable findings grounded in the changed code and the supplied surrounding context/,
    /Scope your review to issues introduced, exposed, or made materially worse by this diff/,
    /Prefer changed-code-only findings: do not flag pre-existing issues in untouched code unless the diff clearly triggers them, routes execution into them, or invalidates an assumption that previously kept them safe/,
    /Use the diff as the starting point and use the current file and related context to verify whether a suspected problem is real/,
  ]);
});

test("file review system prompt requires confident, evidence-based review language", () => {
  const prompt = buildFileReviewSystemPrompt("normal");

  assertMatchesAll(prompt, [
    /Confidence before flagging: prefer missing a weak suspicion over emitting a shaky finding/,
    /Do not speculate or ask for extra verification/,
    /Read for behavior, not intent: infer the runtime effect of the exact change before commenting/,
    /Only emit a finding when you have enough evidence to believe the issue is likely real and fix-worthy/,
    /If the available context is too weak to support a confident claim, do not emit a finding/,
    /The best findings explain the exact failure mode, who or what is impacted, and why the changed code causes it/,
  ]);
});

test("file review system prompt sets expectations for tests and integration impact", () => {
  const prompt = buildFileReviewSystemPrompt("normal");

  assertMatchesAll(prompt, [
    /For tests, review both execution and coverage implications/,
    /Flag tests that now fail to run, assert the wrong behavior, silently stop checking an important path, mask failures, become flaky due to the change, or omit coverage for a newly risky branch, contract, or integration point introduced by the diff/,
    /For tests, do not demand exhaustive coverage or preferred test style. Only raise test findings when the missing or broken test behavior creates a concrete risk tied to the changed code/,
    /Only raise test or migration findings for concrete breakages such as tests not executing, undefined references or imports, empty catches hiding failures, truncated tests, broken runner structure, false-positive assertions, or critical suites no longer running/,
    /Check integration impact across boundaries the file touches: callers and callees, API contracts, serialization, persistence, state transitions, concurrency, caching, feature flags, permissions, configuration, logging, metrics, retries, cleanup, and error handling/,
  ]);
});

test("file review system prompt suppresses style noise and speculative copy review", () => {
  const prompt = buildFileReviewSystemPrompt("normal");

  assertMatchesAll(prompt, [
    /Treat stylistic consistency, naming preference, comment wording, formatting, punctuation, import ordering, refactor wishes, or framework taste as non-issues unless they cause a real bug or materially obscure one/,
    /Do not comment on terminology, punctuation, copy tone, documentation phrasing, or localization style unless the change is likely to break interpolation, rendering, or intended meaning/,
    /Treat suggestions to replace co, standardize expect versus should, clean imports or comments, modernize async style, or improve consistency or readability as non-blocking noise unless the diff shows a concrete failure/,
    /Do not invent hidden requirements, undocumented product expectations, or imagined invariants. Base comments on behavior implied by the code, diff, repository brief, and supplied context/,
  ]);
});

test("user and synthesis prompts include richer review framing", () => {
  const filePrompt = buildFileReviewUserPrompt(
    {
      path: "src/review-engine/engine.ts",
      content: "export function reviewPullRequest() {}",
      patch: "@@ -1 +1 @@",
      context: "Entry point for the review pipeline.",
    },
    coverage,
    repositoryBrief,
    "deep",
  );

  const synthesisPrompt = buildSynthesisUserPrompt(
    {
      owner: "acme",
      repo: "widget",
      title: "Add review levels",
      baseSha: "base",
      headSha: "head",
      changedFiles: [],
    },
    coverage,
    "light",
    "",
  );

  const synthesisSystemPrompt = buildSynthesisSystemPrompt("light");

  assertMatchesAll(filePrompt, [
    /Review level: deep/,
    /Diff:\n@@ -1 \+1 @@/,
    /Current file:\nexport function reviewPullRequest\(\) \{\}/,
  ]);

  assertMatchesAll(synthesisSystemPrompt, [
    /filtered for a light review/i,
    /Write a concise overall assessment based only on the surviving findings that were provided/,
    /The summary should say whether the remaining issues justify blocking, highlight the main risk themes, and mention coverage limits only when they materially affect confidence/,
    /List topRisks only when they are grounded in the surviving findings; phrase them as concrete user, system, or maintenance impact rather than generic warnings/,
    /Do not resurrect filtered, speculative, or hypothetical concerns/,
  ]);

  assertMatchesAll(synthesisPrompt, [
    /Review level: light/,
    /Coverage note: Full coverage across changed files\./,
    /Requested output: provide a terse overall assessment and top risks grounded in the filtered findings below\./,
    /Treat these findings as the surviving issues after filtering. If none remain, say the review is clear at this review level and keep topRisks empty\./,
    /Filtered findings:\n- no findings at this review level/,
  ]);
});
