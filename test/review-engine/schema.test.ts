import test from "node:test";
import assert from "node:assert/strict";
import { buildSummary, dedupeFindings, determineVerdict, normalizeFindings } from "../../src/review-engine/schema.js";

test("determineVerdict requests changes for major findings", () => {
  const findings = normalizeFindings({
    findings: [
      {
        path: "src/index.js",
        line: 10,
        severity: "major",
        title: "Issue",
        body: "This is important.",
        category: "correctness"
      }
    ]
  });

  assert.equal(determineVerdict(findings), "REQUEST_CHANGES");
});

test("dedupeFindings removes duplicates", () => {
  const findings = normalizeFindings({
    findings: [
      {
        path: "src/index.js",
        line: 10,
        severity: "minor",
        title: "Issue",
        body: "Same",
        category: "maintainability"
      },
      {
        path: "src/index.js",
        line: 10,
        severity: "minor",
        title: "Issue",
        body: "Same",
        category: "maintainability"
      }
    ]
  });

  assert.equal(dedupeFindings(findings).length, 1);
  assert.match(buildSummary(dedupeFindings(findings)).body, /Verdict: COMMENT/);
});
