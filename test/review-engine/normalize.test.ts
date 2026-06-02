import test from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_LEVEL_THRESHOLDS,
  buildReviewSummary,
  calibrateFindings,
  dedupeFindings,
  filterFindingsByReviewLevel,
  inspectFinding,
  normalizeFindingCategory,
  normalizeSeverity,
  resolveReviewLevel,
  selectVerdict,
} from "../../src/review-engine/index.js";

test("normalizes severity aliases", () => {
  assert.equal(normalizeSeverity("high"), "major");
  assert.equal(normalizeSeverity("INFO"), "nitpick");
  assert.equal(normalizeSeverity("unknown"), "minor");
});

test("dedupes overlapping findings before selecting verdict", () => {
  const findings = [
    {
      path: "src/auth.js",
      line: 10,
      severity: "major" as const,
      title: "Missing auth check",
      body: "Add an authorization guard.",
      category: "security",
    },
    {
      path: "src/auth.js",
      line: 10,
      severity: "minor" as const,
      title: "missing auth check",
      body: "The handler should validate permissions before continuing.",
      category: "security",
    },
    {
      path: "src/ui.js",
      line: 3,
      severity: "nitpick" as const,
      title: "Whitespace",
      body: "Trim the extra space.",
      category: "style",
    },
  ];

  const deduped = dedupeFindings(findings);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]?.severity, "major");
  assert.equal(selectVerdict(findings), "REQUEST_CHANGES");
});

test("keeps comment verdict when only minor and nitpick findings remain", () => {
  const summary = buildReviewSummary(
    [
      {
        path: "src/app.js",
        line: 12,
        severity: "minor",
        title: "Missing edge-case test",
        body: "Add coverage for empty input.",
        category: "testing",
      },
      {
        path: "src/app.js",
        line: 18,
        severity: "nitpick",
        title: "Rename local",
        body: "Use a clearer variable name.",
        category: "maintainability",
      },
    ],
    "No blocking issues found.",
    "Full coverage.",
    ["Input validation remains light."],
  );

  assert.equal(summary.verdict, "COMMENT");
  assert.deepEqual(summary.severityCounts, {
    critical: 0,
    major: 0,
    minor: 1,
    nitpick: 1,
  });
});

test("filters findings by review level threshold", () => {
  const findings = [
    {
      path: "src/app.js",
      line: 5,
      severity: "critical" as const,
      title: "Crash on null input",
      body: "Guard against null before dereferencing.",
      category: "correctness",
    },
    {
      path: "src/app.js",
      line: 8,
      severity: "minor" as const,
      title: "Missing empty state test",
      body: "Add coverage for empty input handling.",
      category: "testing",
    },
    {
      path: "src/app.js",
      line: 9,
      severity: "nitpick" as const,
      title: "Rename helper",
      body: "Use a clearer name for the local helper.",
      category: "maintainability",
    },
  ];

  assert.deepEqual(REVIEW_LEVEL_THRESHOLDS, {
    light: "major",
    normal: "minor",
    deep: "nitpick",
  });
  assert.deepEqual(
    filterFindingsByReviewLevel(findings, "light").map((finding) => finding.severity),
    ["critical"],
  );
  assert.deepEqual(
    filterFindingsByReviewLevel(findings, "normal").map((finding) => finding.severity),
    ["critical", "minor"],
  );
  assert.deepEqual(
    filterFindingsByReviewLevel(findings, "deep").map((finding) => finding.severity),
    ["critical", "minor", "nitpick"],
  );
});

test("normalizes broad categories from path and content heuristics", () => {
  assert.equal(
    normalizeFindingCategory({
      path: "src/i18n/locales/en/common.json",
      line: 12,
      severity: "minor",
      title: "Missing placeholder",
      body: "The translated string no longer contains {{retireDate}}.",
      category: "correctness",
    }),
    "localization",
  );

  assert.equal(
    normalizeFindingCategory({
      path: "docs/cli.md",
      line: 8,
      severity: "minor",
      title: "Broken command example",
      body: "The docs example omits the required SHA argument.",
      category: "other",
    }),
    "documentation",
  );

  assert.equal(
    normalizeFindingCategory({
      path: "projects/portal-backend/integration-tests/MIGRATION_LOG.md",
      line: 12,
      severity: "minor",
      title: "Jest sandboxing note",
      body: "Testing docs explain per-file app boot requirements during migration.",
      category: "testing",
    }),
    "documentation",
  );
});

test("detects speculation and style-only localization/docs findings", () => {
  const speculative = inspectFinding({
    path: "src/i18n/locales/en/common.json",
    line: 14,
    severity: "major",
    title: "Verify wording with localization team",
    body: "Please confirm the tone still aligns with the glossary.",
    category: "localization",
  });

  const concrete = inspectFinding({
    path: "docs/cli.md",
    line: 18,
    severity: "major",
    title: "Broken command example",
    body: "The docs now tell users to run an invalid command: `agent-review --head` without the required SHA value.",
    category: "documentation",
  });

  assert.equal(speculative.category, "localization");
  assert.equal(speculative.isSpeculative, true);
  assert.equal(speculative.isStyleOnly, true);
  assert.equal(speculative.evidenceStrength, "speculative");

  assert.equal(concrete.category, "documentation");
  assert.equal(concrete.isSpeculative, false);
  assert.equal(concrete.evidenceStrength, "concrete");
});

test("calibrates speculative docs and localization findings before review-level filtering", () => {
  const findings = calibrateFindings([
    {
      path: "src/i18n/locales/en/common.json",
      line: 14,
      severity: "major" as const,
      title: "Verify wording with localization team",
      body: "Please confirm the tone still aligns with the glossary before merging.",
      category: "localization",
    },
    {
      path: "docs/cli.md",
      line: 18,
      severity: "major" as const,
      title: "Broken command example",
      body: "The docs now tell users to run `agent-review --head` without the required SHA value.",
      category: "documentation",
    },
    {
      path: "src/i18n/locales/es/common.json",
      line: 22,
      severity: "major" as const,
      title: "Missing interpolation placeholder",
      body: "The updated string removed the {{retireDate}} placeholder, so the UI will render the wrong message.",
      category: "correctness",
    },
  ]);

  assert.deepEqual(
    findings.map((finding) => [finding.title, finding.severity]),
    [
      ["Broken command example", "minor"],
      ["Verify wording with localization team", "nitpick"],
      ["Missing interpolation placeholder", "major"],
    ],
  );
});

test("drops positive observations and non-issues during calibration", () => {
  const findings = calibrateFindings([
    {
      path: "src/demo/test/aiInsights.calibration.test.ts",
      line: 150,
      severity: "minor" as const,
      title: "Stable sorting checker uses localeCompare correctly",
      body: "This is a positive improvement with no further action needed.",
      category: "testing",
    },
  ]);

  assert.deepEqual(findings, []);
});

test("defaults invalid review level inputs to normal filtering", () => {
  const findings = [
    {
      path: "src/app.js",
      line: 3,
      severity: "nitpick" as const,
      title: "Whitespace",
      body: "Trim the extra space.",
      category: "style",
    },
    {
      path: "src/app.js",
      line: 7,
      severity: "major" as const,
      title: "Broken auth flow",
      body: "The request bypasses authorization checks.",
      category: "security",
    },
  ];

  assert.equal(resolveReviewLevel("unexpected"), "normal");
  assert.deepEqual(
    filterFindingsByReviewLevel(findings, "unexpected").map((finding) => finding.severity),
    ["major"],
  );
});

test("keeps concrete localization and markup breakages while dropping review-level docs noise", () => {
  const findings = calibrateFindings([
    {
      path: "docs/messages/en.json",
      line: 18,
      severity: "major" as const,
      title: "Placeholder interpolation key was removed",
      body: "The updated string drops the `{count}` placeholder, so the caller can no longer interpolate the runtime value.",
      category: "correctness",
    },
    {
      path: "docs/messages/en.json",
      line: 22,
      severity: "nitpick" as const,
      title: "Verify wording with localization team",
      body: "Confirm whether this phrasing still matches the glossary before merging.",
      category: "localization",
    },
    {
      path: "docs/cli.md",
      line: 41,
      severity: "minor" as const,
      title: "Broken command example",
      body: "The docs now tell readers to run `agent-review --repo acme/widget --head` without the required SHA argument.",
      category: "docs",
    },
    {
      path: "docs/help.md",
      line: 12,
      severity: "nitpick" as const,
      title: "Consider softer wording",
      body: "Maybe ask docs to rephrase the sentence so it sounds friendlier.",
      category: "docs",
    },
    {
      path: "docs/messages/es.mdx",
      line: 9,
      severity: "major" as const,
      title: "Broken emphasis tag structure",
      body: "The translated MDX closes `</strong>` before `</Trans>`, which breaks rendering for the component tree.",
      category: "correctness",
    },
  ]);

  assert.deepEqual(
    filterFindingsByReviewLevel(findings, "normal").map((finding) => finding.title),
    [
      "Broken command example",
      "Placeholder interpolation key was removed",
      "Broken emphasis tag structure",
    ],
  );
  assert.equal(selectVerdict(filterFindingsByReviewLevel(findings, "normal")), "REQUEST_CHANGES");
});

test("deep review stays broader than normal for speculative localization or docs follow-ups", () => {
  const findings = calibrateFindings([
    {
      path: "docs/messages/en.json",
      line: 22,
      severity: "minor" as const,
      title: "Verify wording with localization team",
      body: "Confirm whether this phrasing still matches the glossary before merging.",
      category: "localization",
    },
    {
      path: "docs/help.md",
      line: 12,
      severity: "minor" as const,
      title: "Consider softer wording",
      body: "Maybe ask docs to rephrase the sentence so it sounds friendlier.",
      category: "docs",
    },
    {
      path: "docs/messages/es.mdx",
      line: 9,
      severity: "minor" as const,
      title: "Broken Trans component nesting",
      body: "The translated component tree closes `<Link>` before `</Trans>`, which breaks rendering.",
      category: "correctness",
    },
  ]);

  assert.deepEqual(
    filterFindingsByReviewLevel(findings, "normal").map((finding) => finding.title),
    ["Broken Trans component nesting"],
  );
  assert.deepEqual(
    filterFindingsByReviewLevel(findings, "deep").map((finding) => finding.title),
    [
      "Consider softer wording",
      "Verify wording with localization team",
      "Broken Trans component nesting",
    ],
  );
});

test("classifies testing migration chatter as low-signal and concrete test failures as actionable", () => {
  const migrationNoise = inspectFinding({
    path: "integration-tests/migration.integration.test.js",
    line: 17,
    severity: "major",
    title: "Use of deprecated co package in tests",
    body: "Refactor the file to use native async/await for readability and consistency.",
    category: "testing",
  });

  const executionBreakage = inspectFinding({
    path: "integration-tests/pagination.integration.test.js",
    line: 159,
    severity: "major",
    title: "Improper nesting of test blocks inside an it block",
    body: "Nested it blocks inside another test prevent the inner cases from executing.",
    category: "testing",
  });

  assert.equal(migrationNoise.focus, "migration_cleanup");
  assert.equal(migrationNoise.evidenceStrength, "none");
  assert.equal(migrationNoise.dropReason, "non_issue");

  assert.equal(executionBreakage.focus, "execution_breakage");
  assert.equal(executionBreakage.evidenceStrength, "concrete");
});

test("drops or demotes generic testing migration comments while keeping concrete breakages", () => {
  const findings = calibrateFindings([
    {
      path: "integration-tests/migration.integration.test.js",
      line: 17,
      severity: "major" as const,
      title: "Use of deprecated co package in tests",
      body: "Refactor the file to use native async/await for readability and consistency.",
      category: "testing",
    },
    {
      path: "integration-tests/migration.integration.test.js",
      line: 25,
      severity: "minor" as const,
      title: "Assertion style inconsistency",
      body: "Standardize expect versus should for readability across the suite.",
      category: "testing",
    },
    {
      path: "integration-tests/auth.integration.test.js",
      line: 28,
      severity: "minor" as const,
      title: "Assertion style update is appropriate",
      body: "This improves consistency and readability with no further action needed.",
      category: "testing",
    },
    {
      path: "integration-tests/learning.integration.test.js",
      line: 11,
      severity: "major" as const,
      title: "Core learning progress suite disabled",
      body: "The suite is wrapped in describe.skip and the critical learning progress tests never run.",
      category: "testing",
    },
    {
      path: "integration-tests/pagination.integration.test.js",
      line: 159,
      severity: "major" as const,
      title: "Improper nesting of test blocks inside an it block",
      body: "Nested it blocks inside another test prevent the invalid page parameter cases from executing.",
      category: "testing",
    },
    {
      path: "integration-tests/team.integration.test.js",
      line: 44,
      severity: "major" as const,
      title: "Missing import of helpers",
      body: "The file uses helpers.reset but does not import or declare helpers, causing a ReferenceError.",
      category: "testing",
    },
  ]);

  assert.deepEqual(
    findings.map((finding) => [finding.title, finding.severity]),
    [
      ["Core learning progress suite disabled", "major"],
      ["Improper nesting of test blocks inside an it block", "major"],
      ["Missing import of helpers", "major"],
    ],
  );
});

test("drops generic skipped-test commentary that lacks a concrete critical gap", () => {
  const findings = calibrateFindings([
    {
      path: "integration-tests/url-fetcher.integration.test.js",
      line: 80,
      severity: "major" as const,
      title: "Skipped test present",
      body: "There is an it.skip in this file which reduces coverage and should be re-enabled.",
      category: "testing",
    },
  ]);

  assert.deepEqual(findings, []);
});

test("drops generic testing advice that is not tied to execution or coverage failure", () => {
  const findings = calibrateFindings([
    {
      path: "integration-tests/reset-password.integration.test.js",
      line: 10,
      severity: "minor" as const,
      title: "Direct usage of axios in integration tests",
      body: "It is recommended to use a test client or helper methods to reduce external dependencies and flakiness.",
      category: "testing",
    },
    {
      path: "integration-tests/auth/routers/auth/routes/reset-password.integration.test.js",
      line: 35,
      severity: "minor" as const,
      title: "Test does not verify if user status update reverts after test",
      body: "It is recommended to reset or isolate test data changes to maintain test suite reliability.",
      category: "testing",
    },
  ]);

  assert.deepEqual(findings, []);
});

test("drops or demotes generic test-migration chatter before review-level filtering", () => {
  const findings = calibrateFindings([
    {
      path: "test/migration/session.test.ts",
      line: 8,
      severity: "major" as const,
      title: "co cleanup",
      body: "The remaining `co(function* () {})` wrapper is intentional for this pass and no change required in this review.",
      category: "maintainability",
    },
    {
      path: "test/migration/session.test.ts",
      line: 14,
      severity: "major" as const,
      title: "Assertion-style consistency",
      body: "Consider converting the remaining `assert.equal` calls to `assert.strictEqual` for consistency after the migration settles.",
      category: "testing",
    },
    {
      path: "test/migration/session.test.ts",
      line: 18,
      severity: "minor" as const,
      title: "Import cleanup",
      body: "The temporary migration import is already handled by lint and no further action needed here.",
      category: "maintainability",
    },
    {
      path: "test/migration/session.test.ts",
      line: 22,
      severity: "minor" as const,
      title: "Positive observation about migrated coverage",
      body: "This is a positive improvement and the migrated happy-path coverage is well-covered with no further action needed.",
      category: "testing",
    },
    {
      path: "test/migration/session.test.ts",
      line: 26,
      severity: "major" as const,
      title: "Generic modernization advice",
      body: "Consider modernizing the helper names later while the migration settles.",
      category: "maintainability",
    },
  ]);

  assert.deepEqual(findings, []);
  assert.deepEqual(filterFindingsByReviewLevel(findings, "normal"), []);
  assert.deepEqual(filterFindingsByReviewLevel(findings, "deep"), []);
});

test("keeps concrete test-migration failures actionable", () => {
  const findings = calibrateFindings([
    {
      path: "test/session/nested.test.ts",
      line: 12,
      severity: "major" as const,
      title: "Nested test blocks no longer run",
      body: "Nested test blocks inside another `test()` prevent the child assertions from executing under node:test.",
      category: "testing",
    },
    {
      path: "test/session/runtime.test.ts",
      line: 4,
      severity: "major" as const,
      title: "Undefined sinon reference",
      body: "The migration removed the import, but the suite still calls `sinon.stub`, so the file throws before assertions run.",
      category: "correctness",
    },
    {
      path: "test/session/runtime.test.ts",
      line: 30,
      severity: "minor" as const,
      title: "Empty catch hides assertion failures",
      body: "The migrated helper catches thrown errors and ignores them, which masks failing expectations.",
      category: "testing",
    },
    {
      path: "test/session/truncated.test.ts",
      line: 18,
      severity: "major" as const,
      title: "Truncated test body",
      body: "The file ends midway through a `test(\"rejects invalid tokens\"` block, so the suite no longer parses.",
      category: "correctness",
    },
    {
      path: "test/session/ci.test.ts",
      line: 1,
      severity: "critical" as const,
      title: "Critical regression suite no longer runs",
      body: "CI no longer executes the migrated regression suite, so the release path ships without coverage for token rejection.",
      category: "ci",
    },
  ]);

  assert.deepEqual(findings.map((finding) => finding.title), [
    "Critical regression suite no longer runs",
    "Nested test blocks no longer run",
    "Undefined sinon reference",
    "Empty catch hides assertion failures",
    "Truncated test body",
  ]);
  assert.deepEqual(
    filterFindingsByReviewLevel(findings, "normal").map((finding) => finding.title),
    [
      "Critical regression suite no longer runs",
      "Nested test blocks no longer run",
      "Undefined sinon reference",
      "Empty catch hides assertion failures",
      "Truncated test body",
    ],
  );
  assert.equal(selectVerdict(findings), "REQUEST_CHANGES");
});
