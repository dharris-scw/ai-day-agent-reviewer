import test from "node:test";
import assert from "node:assert/strict";

import { planReviewCoverage } from "../../src/review-engine/coverage.js";

test("plans reduced coverage and prioritizes high-risk files first", () => {
  const coverage = planReviewCoverage(
    [
      { path: "docs/readme.md", content: "", patch: "", additions: 10, deletions: 0 },
      { path: "src/auth/session.js", content: "", patch: "", additions: 5, deletions: 4 },
      { path: "package.json", content: "", patch: "", additions: 2, deletions: 1 },
      { path: "web/page.tsx", content: "", patch: "", additions: 100, deletions: 20 },
    ],
    { maxFiles: 2, maxLines: 50 },
  );

  assert.equal(coverage.mode, "reduced");
  assert.deepEqual(coverage.reviewedPaths, ["src/auth/session.js", "package.json"]);
  assert.deepEqual(coverage.skippedPaths, ["web/page.tsx", "docs/readme.md"]);
  assert.match(coverage.note, /Reduced coverage/);
});

test("plans full coverage when thresholds are not exceeded", () => {
  const coverage = planReviewCoverage(
    [{ path: "src/index.js", content: "", patch: "", additions: 10, deletions: 1 }],
    { maxFiles: 5, maxLines: 100 },
  );

  assert.equal(coverage.mode, "full");
  assert.deepEqual(coverage.reviewedPaths, ["src/index.js"]);
  assert.deepEqual(coverage.skippedPaths, []);
});
