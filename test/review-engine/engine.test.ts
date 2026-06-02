import test from "node:test";
import assert from "node:assert/strict";

import { reviewPullRequest } from "../../src/review-engine/engine.js";
import type { PullRequestReviewInput, ReviewEngineModel, StructuredGenerationRequest } from "../../src/review-engine/types.js";

class StubModel implements ReviewEngineModel {
  private readonly handlers: Record<string, unknown>;
  readonly requests: StructuredGenerationRequest<unknown>[] = [];

  constructor(handlers: Record<string, unknown>) {
    this.handlers = handlers;
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    this.requests.push(request as StructuredGenerationRequest<unknown>);
    const response = this.handlers[request.schemaName];
    if (response === undefined) {
      throw new Error(`missing stub for ${request.schemaName}`);
    }

    return request.validate(response);
  }
}

test("runs review pipeline and returns comment verdict when no major findings survive", async () => {
  const result = await reviewPullRequest(
    {
      owner: "acme",
      repo: "widget",
      title: "Tighten validation",
      baseSha: "base",
      headSha: "head",
      changedFiles: [
        {
          path: "src/input.js",
          content: "export function parse(input: string) { return input.trim(); }",
          patch: "@@ -1 +1 @@",
          additions: 8,
          deletions: 1,
          context: "Used by the HTTP handler.",
        },
      ],
      repositoryContext: [{ path: "README.md", content: "Validation should reject malformed values." }],
    },
    new StubModel({
      repository_brief: {
        architectureNotes: ["Input parsing lives in src/input.js"],
        riskAreas: ["Input validation and HTTP request handling"],
      },
      review_file_findings: {
        findings: [
          {
            path: "src/input.js",
            line: 1,
            severity: "minor",
            title: "Missing empty-input test",
            body: "Add a regression test for blank strings.",
            category: "testing",
          },
        ],
      },
      review_synthesis: {
        summary: "No blocking issues found.",
        topRisks: ["Input validation still depends on callers."],
      },
    }),
  );

  assert.equal(result.summary.verdict, "COMMENT");
  assert.equal(result.findings.length, 1);
  assert.match(result.summary.coverageNote, /Full coverage/);
});

test("defaults to normal review and filters nitpicks before synthesis and summary", async () => {
  const model = new StubModel({
    repository_brief: {
      architectureNotes: ["Validation happens in src/input.js"],
      riskAreas: ["Input normalization and caller assumptions"],
    },
    review_file_findings: {
      findings: [
        {
          path: "src/input.js",
          line: 4,
          severity: "minor",
          title: "Missing malformed-input test",
          body: "Add a regression test for malformed values.",
          category: "testing",
        },
        {
          path: "src/input.js",
          line: 8,
          severity: "nitpick",
          title: "Rename local",
          body: "Use a clearer variable name.",
          category: "maintainability",
        },
      ],
    },
    review_synthesis: {
      summary: "Review completed with one actionable finding.",
      topRisks: ["Malformed values are still lightly covered."],
    },
  });

  const result = await reviewPullRequest(
    {
      owner: "acme",
      repo: "widget",
      title: "Refine parsing",
      baseSha: "base",
      headSha: "head",
      changedFiles: [
        {
          path: "src/input.js",
          content: "export function parse(input) { return input.trim(); }",
          patch: "@@ -1 +1 @@",
          additions: 4,
          deletions: 1,
        },
      ],
    },
    model,
  );

  const synthesisRequest = model.requests.find((request) => request.schemaName === "review_synthesis");
  assert.ok(synthesisRequest);
  assert.match(synthesisRequest.user, /Review level: normal/);
  assert.match(synthesisRequest.user, /Missing malformed-input test/);
  assert.doesNotMatch(synthesisRequest.user, /Rename local/);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.severity, "minor");
  assert.deepEqual(result.summary.severityCounts, {
    critical: 0,
    major: 0,
    minor: 1,
    nitpick: 0,
  });
  assert.deepEqual(result.summary.topRisks, ["Malformed values are still lightly covered."]);
});

test("light review keeps verdict logic on surviving major-plus findings", async () => {
  const model = new StubModel({
    repository_brief: {
      architectureNotes: ["Auth checks run in src/auth.js"],
      riskAreas: ["Authorization and request gating"],
    },
    review_file_findings: {
      findings: [
        {
          path: "src/auth.js",
          line: 10,
          severity: "minor",
          title: "Missing unhappy-path test",
          body: "Add coverage for rejected requests.",
          category: "testing",
        },
        {
          path: "src/auth.js",
          line: 14,
          severity: "major",
          title: "Authorization bypass",
          body: "The handler continues even when permission checks fail.",
          category: "security",
        },
      ],
    },
    review_synthesis: {
      summary: "A blocking authorization issue remains.",
      topRisks: ["Unauthorized requests can reach the protected handler."],
    },
  });

  const result = await reviewPullRequest(
    {
      owner: "acme",
      repo: "widget",
      title: "Adjust auth path",
      reviewLevel: "light",
      baseSha: "base",
      headSha: "head",
      changedFiles: [
        {
          path: "src/auth.js",
          content: "export function authorize(req) { return req.user; }",
          patch: "@@ -1 +1 @@",
          additions: 6,
          deletions: 2,
        },
      ],
    },
    model,
  );

  const fileReviewRequest = model.requests.find((request) => request.schemaName === "review_file_findings");
  const synthesisRequest = model.requests.find((request) => request.schemaName === "review_synthesis");
  assert.ok(fileReviewRequest);
  assert.ok(synthesisRequest);
  assert.match(fileReviewRequest.system, /Light review: surface only critical or major issues/);
  assert.match(fileReviewRequest.user, /Review level: light/);
  assert.match(synthesisRequest.user, /Authorization bypass/);
  assert.doesNotMatch(synthesisRequest.user, /Missing unhappy-path test/);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.severity, "major");
  assert.equal(result.summary.verdict, "REQUEST_CHANGES");
  assert.deepEqual(result.summary.severityCounts, {
    critical: 0,
    major: 1,
    minor: 0,
    nitpick: 0,
  });
});

test("deep review preserves nitpick findings and widens prompt guidance", async () => {
  const model = new StubModel({
    repository_brief: {
      architectureNotes: ["Formatting helpers live in src/format.js"],
      riskAreas: ["Display formatting and naming consistency"],
    },
    review_file_findings: {
      findings: [
        {
          path: "src/format.js",
          line: 4,
          severity: "nitpick",
          title: "Rename formatter helper",
          body: "Use a name that reflects the returned display string.",
          category: "maintainability",
        },
      ],
    },
    review_synthesis: {
      summary: "One low-severity maintainability issue remains.",
      topRisks: ["Naming inconsistencies can slow future edits."],
    },
  });

  const result = await reviewPullRequest(
    {
      owner: "acme",
      repo: "widget",
      title: "Polish formatter",
      reviewLevel: "deep",
      baseSha: "base",
      headSha: "head",
      changedFiles: [
        {
          path: "src/format.js",
          content: "export function fmt(v) { return String(v); }",
          patch: "@@ -1 +1 @@",
          additions: 2,
          deletions: 1,
        },
      ],
    },
    model,
  );

  const fileReviewRequest = model.requests.find((request) => request.schemaName === "review_file_findings");
  const synthesisRequest = model.requests.find((request) => request.schemaName === "review_synthesis");
  assert.ok(fileReviewRequest);
  assert.ok(synthesisRequest);
  assert.match(fileReviewRequest.system, /Deep review: inspect broadly/);
  assert.match(fileReviewRequest.user, /Review level: deep/);
  assert.match(synthesisRequest.user, /Rename formatter helper/);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.severity, "nitpick");
  assert.equal(result.summary.verdict, "COMMENT");
  assert.deepEqual(result.summary.severityCounts, {
    critical: 0,
    major: 0,
    minor: 0,
    nitpick: 1,
  });
});

test("normal review filters speculative localization noise before synthesis", async () => {
  const model = new StubModel({
    repository_brief: {
      architectureNotes: ["The engagement banner renders i18n strings through Trans."],
      riskAreas: ["Interpolation and translated markup structure"],
    },
    review_file_findings: {
      findings: [
        {
          path: "src/i18n/locales/en/common.json",
          line: 87,
          severity: "major",
          title: "Verify wording with localization team",
          body: "Please confirm this phrasing still matches the product glossary.",
          category: "localization",
        },
        {
          path: "src/i18n/locales/en/common.json",
          line: 87,
          severity: "major",
          title: "Missing interpolation placeholder",
          body: "The updated string removed {{retireDate}}, so the banner will render without the retirement date.",
          category: "correctness",
        },
      ],
    },
    review_synthesis: {
      summary: "One concrete localization issue remains.",
      topRisks: [
        "Missing interpolation placeholder can break the deprecation banner.",
        "Wording may need localization review.",
      ],
    },
  });

  const result = await reviewPullRequest(
    {
      owner: "acme",
      repo: "widget",
      title: "Update deprecation banner copy",
      reviewLevel: "normal",
      baseSha: "base",
      headSha: "head",
      changedFiles: [
        {
          path: "src/i18n/locales/en/common.json",
          content: "{\"alert\":\"This report retires after {{retireDate}}.\"}",
          patch: "@@ -1 +1 @@",
          additions: 2,
          deletions: 1,
        },
      ],
    },
    model,
  );

  const synthesisRequest = model.requests.find((request) => request.schemaName === "review_synthesis");
  assert.ok(synthesisRequest);
  assert.match(synthesisRequest.user, /Missing interpolation placeholder/);
  assert.doesNotMatch(synthesisRequest.user, /Verify wording with localization team/);

  assert.deepEqual(result.findings.map((finding) => finding.title), ["Missing interpolation placeholder"]);
  assert.deepEqual(result.summary.topRisks, ["Missing interpolation placeholder can break the deprecation banner."]);
  assert.equal(result.summary.verdict, "REQUEST_CHANGES");
});

test("deep review keeps concrete docs and localization findings while dropping positive observations", async () => {
  const model = new StubModel({
    repository_brief: {
      architectureNotes: ["CLI docs live in docs/cli.md and translations use MDX tags."],
      riskAreas: ["Broken command examples and translated markup structure"],
    },
    review_file_findings: {
      findings: [
        {
          path: "docs/cli.md",
          line: 14,
          severity: "minor",
          title: "Broken command example",
          body: "The docs omit the required SHA argument, so readers cannot run the command successfully.",
          category: "documentation",
        },
        {
          path: "src/i18n/locales/es/common.mdx",
          line: 22,
          severity: "minor",
          title: "Broken Trans component nesting",
          body: "The translation closes </strong> before </Trans>, which breaks rendering.",
          category: "correctness",
        },
        {
          path: "src/demo/test/aiInsights.calibration.test.ts",
          line: 150,
          severity: "minor",
          title: "Stable sorting checker uses localeCompare correctly",
          body: "This is a positive improvement with no further action needed.",
          category: "testing",
        },
      ],
    },
    review_synthesis: {
      summary: "Two actionable issues remain.",
      topRisks: [
        "Broken command example can mislead users.",
        "Broken Trans component nesting can break rendering.",
        "Stable sorting checker uses localeCompare correctly.",
      ],
    },
  });

  const result = await reviewPullRequest(
    {
      owner: "acme",
      repo: "widget",
      title: "Refresh docs and translations",
      reviewLevel: "deep",
      baseSha: "base",
      headSha: "head",
      changedFiles: [
        {
          path: "docs/cli.md",
          content: "Run agent-review --head",
          patch: "@@ -1 +1 @@",
          additions: 1,
          deletions: 1,
        },
      ],
    },
    model,
  );

  assert.deepEqual(result.findings.map((finding) => finding.title), [
    "Broken command example",
    "Broken Trans component nesting",
  ]);
  assert.deepEqual(result.summary.topRisks, [
    "Broken command example can mislead users.",
    "Broken Trans component nesting can break rendering.",
  ]);
  assert.equal(result.summary.verdict, "COMMENT");
});

test("normal review suppresses speculative docs and localization noise while keeping concrete breakages", async () => {
  const model = new StubModel({
    repository_brief: {
      architectureNotes: ["Localized copy is rendered through Trans components and CLI docs live under docs/cli.md"],
      riskAreas: ["Interpolation placeholders, component markup, and executable command examples"],
    },
    review_file_findings: {
      findings: [
        {
          path: "docs/messages/en.json",
          line: 14,
          severity: "nitpick",
          title: "Verify wording with localization team",
          body: "Confirm whether the new English phrasing still matches the approved glossary.",
          category: "localization",
        },
        {
          path: "docs/messages/en.json",
          line: 14,
          severity: "major",
          title: "Placeholder interpolation key was removed",
          body: "The updated string no longer includes `{count}`, so the caller cannot interpolate the runtime value.",
          category: "correctness",
        },
        {
          path: "docs/cli.md",
          line: 41,
          severity: "minor",
          title: "Broken docs command example",
          body: "The new example runs `agent-review --repo acme/widget --head` without the required SHA argument.",
          category: "docs",
        },
        {
          path: "docs/messages/es.mdx",
          line: 21,
          severity: "major",
          title: "Broken Trans component nesting",
          body: "The translated MDX closes `</strong>` before `</Trans>`, which breaks the rendered component tree.",
          category: "correctness",
        },
      ],
    },
    review_synthesis: {
      summary: "Concrete docs and localization breakages remain after filtering out speculative wording feedback.",
      topRisks: ["Localized rendering and CLI examples can mislead or fail at runtime."],
    },
  });

  const result = await reviewPullRequest(
    {
      owner: "acme",
      repo: "widget",
      title: "Refresh localized help copy",
      baseSha: "base",
      headSha: "head",
      changedFiles: [
        {
          path: "docs/messages/en.json",
          content: '{"cta":"Show {{count}} items"}',
          patch: "@@ -14 +14 @@",
          additions: 3,
          deletions: 2,
          context: "Rendered through <Trans> in the settings screen.",
        },
      ],
      repositoryContext: [{ path: "docs/cli.md", content: "CLI examples must be copy-paste runnable." }],
    },
    model,
  );

  const fileReviewRequest = model.requests.find((request) => request.schemaName === "review_file_findings");
  const synthesisRequest = model.requests.find((request) => request.schemaName === "review_synthesis");
  assert.ok(fileReviewRequest);
  assert.ok(synthesisRequest);
  assert.match(fileReviewRequest.system, /Do not speculate or ask for extra verification/);
  assert.match(
    fileReviewRequest.system,
    /Do not comment on terminology, punctuation, copy tone, documentation phrasing, or localization style unless the change is likely to break interpolation, rendering, or intended meaning/,
  );
  assert.match(synthesisRequest.user, /Placeholder interpolation key was removed/);
  assert.match(synthesisRequest.user, /Broken docs command example/);
  assert.match(synthesisRequest.user, /Broken Trans component nesting/);
  assert.doesNotMatch(synthesisRequest.user, /Verify wording with localization team/);

  assert.deepEqual(
    result.findings.map((finding) => finding.title),
    [
      "Broken docs command example",
      "Placeholder interpolation key was removed",
      "Broken Trans component nesting",
    ],
  );
  assert.equal(result.summary.verdict, "REQUEST_CHANGES");
  assert.deepEqual(result.summary.severityCounts, {
    critical: 0,
    major: 1,
    minor: 2,
    nitpick: 0,
  });
});

test("deep review stays broader than normal and verdict follows surviving calibrated findings", async () => {
  const model = new StubModel({
    repository_brief: {
      architectureNotes: ["Localized docs ship with CLI examples and message catalogs."],
      riskAreas: ["Docs correctness, translator guidance, and placeholder integrity"],
    },
    review_file_findings: {
      findings: [
        {
          path: "docs/messages/en.json",
          line: 18,
          severity: "nitpick",
          title: "Verify wording with localization team",
          body: "Confirm whether the revised CTA still matches the glossary.",
          category: "localization",
        },
        {
          path: "docs/help.md",
          line: 27,
          severity: "nitpick",
          title: "Consider softer docs wording",
          body: "Maybe rephrase the troubleshooting step so it sounds less abrupt.",
          category: "docs",
        },
        {
          path: "docs/cli.md",
          line: 41,
          severity: "minor",
          title: "Broken docs command path",
          body: "The example now points to `./scripts/reveiw.mjs`, which does not exist.",
          category: "docs",
        },
      ],
    },
    review_synthesis: {
      summary: "Deep review kept low-severity docs feedback, but nothing remains that should block the change.",
      topRisks: ["Readers may copy an invalid docs command until the path is fixed."],
    },
  });

  const normalResult = await reviewPullRequest(
    {
      owner: "acme",
      repo: "widget",
      title: "Adjust help copy",
      baseSha: "base",
      headSha: "head",
      changedFiles: [
        {
          path: "docs/cli.md",
          content: "node ./scripts/reveiw.mjs --repo acme/widget",
          patch: "@@ -41 +41 @@",
          additions: 2,
          deletions: 1,
        },
      ],
    },
    model,
  );

  const deepModel = new StubModel({
    repository_brief: {
      architectureNotes: ["Localized docs ship with CLI examples and message catalogs."],
      riskAreas: ["Docs correctness, translator guidance, and placeholder integrity"],
    },
    review_file_findings: {
      findings: [
        {
          path: "docs/messages/en.json",
          line: 18,
          severity: "nitpick",
          title: "Verify wording with localization team",
          body: "Confirm whether the revised CTA still matches the glossary.",
          category: "localization",
        },
        {
          path: "docs/help.md",
          line: 27,
          severity: "nitpick",
          title: "Consider softer docs wording",
          body: "Maybe rephrase the troubleshooting step so it sounds less abrupt.",
          category: "docs",
        },
        {
          path: "docs/cli.md",
          line: 41,
          severity: "minor",
          title: "Broken docs command path",
          body: "The example now points to `./scripts/reveiw.mjs`, which does not exist.",
          category: "docs",
        },
      ],
    },
    review_synthesis: {
      summary: "Deep review kept low-severity docs feedback, but nothing remains that should block the change.",
      topRisks: ["Readers may copy an invalid docs command until the path is fixed."],
    },
  });

  const deepResult = await reviewPullRequest(
    {
      owner: "acme",
      repo: "widget",
      title: "Adjust help copy",
      reviewLevel: "deep",
      baseSha: "base",
      headSha: "head",
      changedFiles: [
        {
          path: "docs/cli.md",
          content: "node ./scripts/reveiw.mjs --repo acme/widget",
          patch: "@@ -41 +41 @@",
          additions: 2,
          deletions: 1,
        },
      ],
    },
    deepModel,
  );

  const normalSynthesisRequest = model.requests.find((request) => request.schemaName === "review_synthesis");
  const deepSynthesisRequest = deepModel.requests.find((request) => request.schemaName === "review_synthesis");
  assert.ok(normalSynthesisRequest);
  assert.ok(deepSynthesisRequest);
  assert.match(normalSynthesisRequest.user, /Broken docs command path/);
  assert.doesNotMatch(normalSynthesisRequest.user, /Verify wording with localization team/);
  assert.doesNotMatch(normalSynthesisRequest.user, /Consider softer docs wording/);
  assert.match(deepSynthesisRequest.user, /Broken docs command path/);
  assert.match(deepSynthesisRequest.user, /Verify wording with localization team/);
  assert.match(deepSynthesisRequest.user, /Consider softer docs wording/);

  assert.deepEqual(normalResult.findings.map((finding) => finding.title), ["Broken docs command path"]);
  assert.deepEqual(
    deepResult.findings.map((finding) => finding.title),
    [
      "Broken docs command path",
      "Consider softer docs wording",
      "Verify wording with localization team",
    ],
  );
  assert.equal(normalResult.summary.verdict, "COMMENT");
  assert.equal(deepResult.summary.verdict, "COMMENT");
  assert.deepEqual(normalResult.summary.severityCounts, {
    critical: 0,
    major: 0,
    minor: 1,
    nitpick: 0,
  });
  assert.deepEqual(deepResult.summary.severityCounts, {
    critical: 0,
    major: 0,
    minor: 1,
    nitpick: 2,
  });
});

test("platform-style testing migration noise keeps the same verdict across light normal and deep", async () => {
  const createModel = () =>
    new StubModel({
      repository_brief: {
        architectureNotes: ["The repository is migrating a large integration-test suite to newer patterns."],
        riskAreas: ["Tests not executing, swallowed failures, and missing imports during migration."],
      },
      review_file_findings: {
        findings: [
          {
            path: "integration-tests/learning.integration.test.js",
            line: 11,
            severity: "major",
            title: "Core learning progress suite disabled",
            body: "The suite is wrapped in describe.skip and the critical learning progress tests never run.",
            category: "testing",
          },
          {
            path: "integration-tests/pagination.integration.test.js",
            line: 159,
            severity: "major",
            title: "Improper nesting of test blocks inside an it block",
            body: "Nested it blocks inside another test prevent the invalid page parameter cases from executing.",
            category: "testing",
          },
          {
            path: "integration-tests/team.integration.test.js",
            line: 44,
            severity: "major",
            title: "Missing import of helpers",
            body: "The file uses helpers.reset but does not import or declare helpers, causing a ReferenceError.",
            category: "testing",
          },
          {
            path: "integration-tests/migration.integration.test.js",
            line: 17,
            severity: "major",
            title: "Use of deprecated co package in tests",
            body: "This cleanup can happen later and no change required in this migration review.",
            category: "testing",
          },
          {
            path: "integration-tests/migration.integration.test.js",
            line: 25,
            severity: "minor",
            title: "Assertion style inconsistency",
            body: "Standardize expect versus should later; no further action needed in this migration review.",
            category: "testing",
          },
          {
            path: "integration-tests/migration.integration.test.js",
            line: 28,
            severity: "minor",
            title: "Assertion style update is appropriate",
            body: "This improves consistency and readability with no further action needed.",
            category: "testing",
          },
          {
            path: "integration-tests/assessments.integration.test.js",
            line: 88,
            severity: "major",
            title: "Empty catch block swallows assertion failures",
            body: "The catch block is empty, so this test can falsely pass even when the expected error never occurs.",
            category: "testing",
          },
        ],
      },
      review_synthesis: {
        summary: "Concrete test execution failures remain after filtering migration chatter.",
        topRisks: [
          "Critical suites are not running and nested tests prevent coverage from executing.",
          "Maybe clean up naming consistency and file layout later.",
        ],
      },
    });

  const [light, normal, deep] = await Promise.all(
    (["light", "normal", "deep"] as const).map((reviewLevel) =>
      reviewPullRequest(
        {
          owner: "acme",
          repo: "widget",
          title: "Migrate integration tests",
          reviewLevel,
          baseSha: "base",
          headSha: "head",
          changedFiles: [
            {
              path: "integration-tests/learning.integration.test.js",
              content: "describe.skip('learning progress', () => {});",
              patch: "@@ -1 +1 @@",
              additions: 10,
              deletions: 4,
            },
          ],
        },
        createModel(),
      ),
    ),
  );

  assert.equal(light.summary.verdict, "REQUEST_CHANGES");
  assert.equal(normal.summary.verdict, "REQUEST_CHANGES");
  assert.equal(deep.summary.verdict, "REQUEST_CHANGES");

  assert.deepEqual(light.findings.map((finding) => finding.title), [
    "Empty catch block swallows assertion failures",
    "Core learning progress suite disabled",
    "Improper nesting of test blocks inside an it block",
    "Missing import of helpers",
  ]);

  assert.deepEqual(normal.findings.map((finding) => finding.title), light.findings.map((finding) => finding.title));
  assert.deepEqual(deep.findings.map((finding) => finding.title), light.findings.map((finding) => finding.title));

  assert.deepEqual(normal.summary.topRisks, [
    "Critical suites are not running and nested tests prevent coverage from executing.",
    "Maybe clean up naming consistency and file layout later.",
  ]);
  assert.deepEqual(deep.summary.topRisks, [
    "Critical suites are not running and nested tests prevent coverage from executing.",
    "Maybe clean up naming consistency and file layout later.",
  ]);
});

test("platform#9993 migration chatter is filtered while concrete test failures drive the same verdict across review levels", async () => {
  const input: PullRequestReviewInput = {
    owner: "acme",
    repo: "widget",
    title: "Migrate auth tests to node:test",
    baseSha: "base",
    headSha: "head",
    changedFiles: [
      {
        path: "test/auth/session.test.ts",
        content: "test('session auth', async () => {});",
        patch: "@@ -1 +1 @@",
        additions: 42,
        deletions: 38,
        context: "Migrates mocha coverage for critical session auth flows to node:test.",
      },
    ],
    repositoryContext: [
      {
        path: "test/README.md",
        content: "Critical auth suites must keep running in CI after framework migrations.",
      },
    ],
  };

  const handlers = {
    repository_brief: {
      architectureNotes: ["Critical auth regressions are covered from test/auth/session.test.ts."],
      riskAreas: ["Nested node:test usage, missing imports, swallowed failures, and CI coverage gaps"],
    },
    review_file_findings: {
      findings: [
        {
          path: "test/auth/session.test.ts",
          line: 5,
          severity: "major",
          title: "co cleanup",
          body: "The remaining `co(function* () {})` wrapper is intentional for this pass and no change required in this review.",
          category: "maintainability",
        },
        {
          path: "test/auth/session.test.ts",
          line: 9,
          severity: "major",
          title: "Assertion-style consistency",
          body: "This is cleanup-only migration follow-up and no action needed for correctness in this PR.",
          category: "testing",
        },
        {
          path: "test/auth/session.test.ts",
          line: 13,
          severity: "minor",
          title: "Import cleanup",
          body: "The temporary migration imports are already handled by lint and already covered elsewhere.",
          category: "maintainability",
        },
        {
          path: "test/auth/session.test.ts",
          line: 17,
          severity: "minor",
          title: "Positive migrated coverage note",
          body: "This is a positive improvement with no further action needed.",
          category: "testing",
        },
        {
          path: "test/auth/session.test.ts",
          line: 21,
          severity: "major",
          title: "Generic modernization advice",
          body: "Consider modernizing the helper names later; no fix needed in this PR.",
          category: "maintainability",
        },
        {
          path: "test/auth/session.test.ts",
          line: 28,
          severity: "major",
          title: "Nested tests no longer run",
          body: "The migration now calls `test()` inside another `test()`, so the child assertions never execute under node:test.",
          category: "testing",
        },
        {
          path: "test/auth/session.test.ts",
          line: 34,
          severity: "major",
          title: "Undefined sinon reference",
          body: "The migration removed the import, but the suite still calls `sinon.stub`, so the file throws before assertions run.",
          category: "correctness",
        },
        {
          path: "test/auth/session.test.ts",
          line: 41,
          severity: "minor",
          title: "Empty catch hides assertion failures",
          body: "The migrated helper catches thrown errors and ignores them, which masks failing expectations.",
          category: "testing",
        },
        {
          path: "test/auth/session.test.ts",
          line: 52,
          severity: "major",
          title: "Truncated test body",
          body: "The file ends midway through a `test(\"rejects revoked sessions\"` block, so the suite no longer parses.",
          category: "correctness",
        },
        {
          path: "test/auth/session.test.ts",
          line: 1,
          severity: "critical",
          title: "Critical auth suite no longer runs",
          body: "CI no longer executes the migrated session auth suite, so revoked-session coverage disappears from the release path.",
          category: "ci",
        },
      ],
    },
    review_synthesis: {
      summary:
        "Concrete migration regressions remain: nested node:test structure, undefined sinon usage, truncated coverage, and the auth suite no longer running in CI.",
      topRisks: [
        "Nested node:test structure keeps child assertions from running.",
        "Undefined sinon usage crashes the migrated suite before assertions run.",
        "Empty catches swallow failing expectations in the migrated helper.",
        "The truncated revoked-session test file no longer parses.",
        "The critical auth suite no longer runs in CI.",
        "General modernization cleanup is still pending.",
        "Assertion style consistency is still uneven.",
      ],
    },
  } as const;

  const runForLevel = async (reviewLevel?: "light" | "normal" | "deep") => {
    const model = new StubModel(handlers);
    const result = await reviewPullRequest(
      {
        ...input,
        ...(reviewLevel ? { reviewLevel } : {}),
      },
      model,
    );
    const synthesisRequest = model.requests.find((request) => request.schemaName === "review_synthesis");
    assert.ok(synthesisRequest);

    return { result, synthesisRequest };
  };

  const light = await runForLevel("light");
  const normal = await runForLevel("normal");
  const deep = await runForLevel("deep");

  assert.equal(light.result.summary.verdict, "REQUEST_CHANGES");
  assert.equal(normal.result.summary.verdict, "REQUEST_CHANGES");
  assert.equal(deep.result.summary.verdict, "REQUEST_CHANGES");

  assert.deepEqual(normal.result.findings.map((finding) => finding.title), [
    "Critical auth suite no longer runs",
    "Nested tests no longer run",
    "Undefined sinon reference",
    "Empty catch hides assertion failures",
    "Truncated test body",
  ]);
  assert.deepEqual(deep.result.findings.map((finding) => finding.title), [
    "Critical auth suite no longer runs",
    "Nested tests no longer run",
    "Undefined sinon reference",
    "Empty catch hides assertion failures",
    "Truncated test body",
  ]);

  assert.match(normal.synthesisRequest.user, /Nested tests no longer run/);
  assert.match(normal.synthesisRequest.user, /Undefined sinon reference/);
  assert.match(normal.synthesisRequest.user, /Empty catch hides assertion failures/);
  assert.match(normal.synthesisRequest.user, /Truncated test body/);
  assert.match(normal.synthesisRequest.user, /Critical auth suite no longer runs/);
  assert.doesNotMatch(normal.synthesisRequest.user, /co cleanup/i);
  assert.doesNotMatch(normal.synthesisRequest.user, /Assertion-style consistency/);
  assert.doesNotMatch(normal.synthesisRequest.user, /Import cleanup/);
  assert.doesNotMatch(normal.synthesisRequest.user, /Positive migrated coverage note/);
  assert.doesNotMatch(normal.synthesisRequest.user, /Generic modernization advice/);

  assert.match(deep.synthesisRequest.user, /Nested tests no longer run/);
  assert.match(deep.synthesisRequest.user, /Undefined sinon reference/);
  assert.match(deep.synthesisRequest.user, /Empty catch hides assertion failures/);
  assert.match(deep.synthesisRequest.user, /Truncated test body/);
  assert.match(deep.synthesisRequest.user, /Critical auth suite no longer runs/);
  assert.doesNotMatch(deep.synthesisRequest.user, /co cleanup/i);
  assert.doesNotMatch(deep.synthesisRequest.user, /Assertion-style consistency/);
  assert.doesNotMatch(deep.synthesisRequest.user, /Import cleanup/);
  assert.doesNotMatch(deep.synthesisRequest.user, /Positive migrated coverage note/);
  assert.doesNotMatch(deep.synthesisRequest.user, /Generic modernization advice/);

  assert.equal(
    normal.result.summary.summary,
    "Concrete migration regressions remain: nested node:test structure, undefined sinon usage, truncated coverage, and the auth suite no longer running in CI.",
  );
  assert.equal(deep.result.summary.summary, normal.result.summary.summary);
  assert.deepEqual(normal.result.summary.topRisks, [
    "Nested node:test structure keeps child assertions from running.",
    "Undefined sinon usage crashes the migrated suite before assertions run.",
    "Empty catches swallow failing expectations in the migrated helper.",
    "The truncated revoked-session test file no longer parses.",
    "The critical auth suite no longer runs in CI.",
  ]);
  assert.deepEqual(deep.result.summary.topRisks, normal.result.summary.topRisks);
});
