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

test("file review prompts describe the breadth for each review level", () => {
  assert.match(buildFileReviewSystemPrompt("light"), /surface only critical or major issues when they are clearly evidenced and worth blocking on/);
  assert.match(buildFileReviewSystemPrompt("normal"), /report clearly evidenced critical, major, and minor issues/);
  assert.match(buildFileReviewSystemPrompt("deep"), /including minor and nitpick findings when they are worth the author's time/);
});

test("file review system prompt makes severity calibration conservative", () => {
  const prompt = buildFileReviewSystemPrompt("normal");

  assert.match(prompt, /Assign the lowest severity that is clearly justified by concrete evidence/);
  assert.match(prompt, /Critical: reserve for clear release-blocking correctness, security, data-loss, or availability regressions with strong evidence/);
  assert.match(prompt, /Major: reserve for concrete, high-likelihood issues with meaningful user, correctness, performance, or maintenance impact/);
  assert.match(prompt, /Minor: use for specific non-blocking issues with credible impact; do not use minor for vague risks, preferences, or hypothetical follow-up checks/);
  assert.match(prompt, /Nitpick: use only for low-impact but still actionable issues; skip it when the point is mostly style, taste, or restating team preference/);
});

test("file review system prompt discourages speculation and copy-style noise", () => {
  const prompt = buildFileReviewSystemPrompt("normal");

  assert.match(prompt, /Do not speculate or ask for extra verification/);
  assert.match(prompt, /Avoid findings framed as verify, confirm, ensure, consider, might, could, check, or similar unless the diff provides concrete evidence/);
  assert.match(prompt, /Do not comment on terminology, punctuation, copy tone, documentation phrasing, or localization style unless the change is likely to break interpolation, rendering, or intended meaning/);
});

test("file review system prompt suppresses test and migration cleanup noise", () => {
  const prompt = buildFileReviewSystemPrompt("normal");

  assert.match(prompt, /For tests and migrations, emit comments only when they are concrete, actionable, and tied to a real failure mode/);
  assert.match(prompt, /Treat suggestions to replace co, standardize expect versus should, clean imports or comments, modernize async style, or improve consistency or readability as non-blocking noise/);
  assert.match(prompt, /Only raise test or migration findings for concrete breakages such as tests not executing, undefined references or imports, empty catches hiding failures, truncated tests, broken runner structure, false-positive assertions, or critical suites no longer running/);
});

test("user prompts include the selected review level and filtered synthesis framing", () => {
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

  assert.match(filePrompt, /Review level: deep/);
  assert.match(buildSynthesisSystemPrompt("light"), /filtered for a light review/);
  assert.match(synthesisPrompt, /Review level: light/);
  assert.match(synthesisPrompt, /Filtered findings:\n- no findings at this review level/);
});
