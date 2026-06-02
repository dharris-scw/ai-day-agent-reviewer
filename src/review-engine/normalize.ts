import { REVIEW_LEVEL_THRESHOLDS } from "./types.js";
import type {
  ReviewEvidenceStrength,
  ReviewFinding,
  ReviewFindingCalibration,
  ReviewFindingCategory,
  ReviewFindingFocus,
  ReviewLevel,
  ReviewSeverity,
  ReviewSummary,
  ReviewTestingFocus,
  ReviewVerdict,
} from "./types.js";

const SEVERITY_ALIASES: Record<string, ReviewSeverity> = {
  blocker: "critical",
  critical: "critical",
  high: "major",
  major: "major",
  medium: "minor",
  moderate: "minor",
  low: "nitpick",
  minor: "minor",
  nit: "nitpick",
  nitpick: "nitpick",
  info: "nitpick",
};

const SEVERITY_ORDER: ReviewSeverity[] = ["nitpick", "minor", "major", "critical"];
const SPECULATIVE_PATTERN =
  /\b(verify|confirm|ensure|consider|may|might|could|check with|validate with|make sure|align with|recommended to validate|please validate|please verify|please confirm)\b/i;
const POSITIVE_PATTERN =
  /\b(no further action needed|no action needed|looks good|correctly|good sanity check|positive improvement|positive change|well-covered|with no further action|this is a positive improvement|reduces clutter|improves code cleanliness|cleaner without further action)\b/i;
const NON_ISSUE_PATTERN =
  /\b(not an issue|non-issue|false positive|intentional|by design|already handled|already covered|no fix needed|no change required)\b/i;
const TESTING_MIGRATION_NOISE_PATTERN =
  /\b(replac(?:e|ing)\s+co\b|use of deprecated co|deprecated ['"`]?co['"`]?|async\/await|generator(?:-based)?|assertion style|jest style|chai style|expect(?:\(\))?|should(?:\.|js)?|unused imports?|clean(?:ing)? imports?|commented(?:-out)? code|moderni[sz](?:e|ing)|consisten(?:cy|t)|readability|maintainability|remove unused|cleanup|refactor(?:ing)? tests?)\b/i;
const TESTING_BREAKAGE_PATTERN =
  /\b(nested ['"`]?(?:it|test|describe)['"`]?|nested test blocks?|nested tests? no longer run|calls? test\(\) inside another test|tests? (?:are )?not executing|tests? (?:do(?:es)? not|don't|doesn't|never|fail to|no longer)\s+(?:run|execute)|zero[- ]test\b|zero tests?\b|0 tests?\b|never ran|critical suite(?:s)? not running|runner crashes?|broken runner structure|invalid runner structure|referenceerror|undefined (?:variable|import|identifier|reference|ref)|undefined [a-z0-9_$]+ reference|missing import|removed the import|unresolved import|not declared|throws before assertions run|empty catch|swallow(?:ed|s|ing)? (?:errors?|failures?)|false[- ]positive assertions?|missing assertions?|no error is thrown|truncated tests?\b|unfinished tests?\b|incomplete tests?\b|cuts off abruptly|syntax error)\b/i;
const TESTING_CONCRETE_COVERAGE_GAP_PATTERN =
  /\b(describe\.skip|it\.skip|test\.skip|(?:xit|xtest|xdescribe|fit|fdescribe)\b|skipp?ed tests?\b|disabled tests?\b|todo tests?\b|commented(?:-out)? tests?\b)\b/i;
const TESTING_COVERAGE_GAP_PATTERN =
  /\b(skipp?ed tests?|disabled tests?|todo tests?|coverage gap|coverage loss|no coverage|unimplemented test|missing regression tests?|missing test coverage|needs? (?:more )?tests?|no longer runs|no longer executes)\b/i;
const TESTING_POSITIVE_PATTERN =
  /\b(aligns with jest|improves consistency|improves readability|appropriate|beneficial|good practice|is correct|is appropriate|is beneficial|improves maintainability)\b/i;
const TESTING_GENERAL_ADVICE_PATTERN =
  /\b(use a test client|helper methods?|external dependenc(?:y|ies)|flak(?:y|iness)|parameteri[sz](?:e|ing)|stronger assurance|stronger assertions?|more detailed assertions?|more robust|prefer using|recommend(?:ed)? (?:to )?(?:use|add|remove|reset|isolate|clone|centraliz(?:e|ing)|batch(?:ing)?|updat(?:e|ing)|enable|stabiliz(?:e|ing))|consider (?:using|making|resetting|isolating|cloning|centralizing|batching|updating|enabling|stabilizing|reducing|parameterizing|verifying|adding|removing)|brittle tests?|test robustness|test reliability|future maintenance|improve integration coverage|improve test coverage)\b/i;
const TEST_FILE_PATH_PATTERN = /(^|\/)(test|tests|integration-tests|__tests__)(\/|$)|\.test\.[a-z]+$/i;
const LOCALIZATION_PATH_PATTERN =
  /\b(i18n|locale|locales|translation|translations|json-autotranslate-cache)\b/i;
const DOCUMENTATION_PATH_PATTERN = /(^|\/)(docs?|readme)(\/|\.|$)|\.mdx?$/i;
const STYLE_ONLY_PATTERN =
  /\b(terminology|tone|clarity|punctuation|wording|phrasing|copy|style|formalit|consisten(?:cy|t)|readability|grammar|spelling|spacing)\b/i;
const CONCRETE_DOCS_LOCALIZATION_PATTERN =
  /\b(broken interpolation|interpolation|placeholder|raw tags?|tag structure|component structure|mismatched tag|invalid path|invalid command|broken link|missing placeholder|corrupted text|garbled|render(?:ing)? issue|runtime error|literal \{\{|\b404\b|unresolved|required [a-z0-9_-]+ argument|omits the required|missing required)\b/i;
const HIGH_IMPACT_DOCS_LOCALIZATION_PATTERN =
  /\b(interpolation|placeholder|raw tags?|tag structure|component structure|mismatched tag|corrupted text|garbled|render(?:ing)? issue|runtime error|broken link target|literal \{\{)\b/i;

const CATEGORY_ALIASES: Array<[RegExp, ReviewFindingCategory]> = [
  [/\b(security|auth|authentication|authorization|permissions?|xss|csrf|injection)\b/i, "security"],
  [/\b(correctness|bug|logic|runtime|crash|null|broken|failure|workflow|regression)\b/i, "correctness"],
  [/\b(doc|docs|documentation|readme)\b/i, "documentation"],
  [/\b(i18n|l10n|translation|translations|localization|locale)\b/i, "localization"],
  [/\b(test|testing|coverage|regression test)\b/i, "testing"],
  [/\b(maintainability|refactor|cleanup|naming|style)\b/i, "maintainability"],
  [/\b(performance|latency|slow|memory)\b/i, "performance"],
  [/\b(usability|ux|accessibility|a11y)\b/i, "usability"],
  [/\b(ci|workflow|build|pipeline|infra|infrastructure)\b/i, "ci"],
];

const STOP_WORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "into",
  "when",
  "then",
  "than",
  "were",
  "will",
  "your",
  "their",
  "about",
  "only",
  "should",
  "could",
]);
const SUMMARY_TESTING_NOISE_PATTERN =
  /\b(async\/await|co\b|assertion style|expect\b|should\b|consisten(?:cy|t)|readability|unused imports?|cleanup|moderni[sz](?:e|ation)|maintainability)\b/i;

export function normalizeSeverity(severity: string): ReviewSeverity {
  const normalized = SEVERITY_ALIASES[severity.trim().toLowerCase()];
  return normalized ?? "minor";
}

export function normalizeFinding(finding: ReviewFinding): ReviewFinding {
  return {
    ...finding,
    path: finding.path.trim(),
    line: typeof finding.line === "number" && Number.isInteger(finding.line) && finding.line > 0 ? finding.line : null,
    severity: normalizeSeverity(finding.severity),
    title: finding.title.trim(),
    body: finding.body.trim(),
    category: finding.category.trim().toLowerCase(),
  };
}

export function normalizeFindingCategory(finding: ReviewFinding): ReviewFindingCategory {
  const normalized = normalizeFinding(finding);
  const haystack = [normalized.category, normalized.path, normalized.title, normalized.body].join("\n");

  if (LOCALIZATION_PATH_PATTERN.test(normalized.path) || /\b(localization|translation|translations|locale|i18n)\b/i.test(haystack)) {
    return "localization";
  }

  if (DOCUMENTATION_PATH_PATTERN.test(normalized.path) || /\b(documentation|readme|docs?)\b/i.test(haystack)) {
    return "documentation";
  }

  if (TEST_FILE_PATH_PATTERN.test(normalized.path) || /\b(testing|test suite|integration test|unit test)\b/i.test(haystack)) {
    return "testing";
  }

  for (const [pattern, category] of CATEGORY_ALIASES) {
    if (pattern.test(haystack)) {
      return category;
    }
  }

  return "other";
}

export function inspectFinding(finding: ReviewFinding): ReviewFindingCalibration {
  const normalized = normalizeFinding(finding);
  const category = normalizeFindingCategory(normalized);
  const haystack = [normalized.title, normalized.body, normalized.category, normalized.path].join("\n");
  const isSpeculative = SPECULATIVE_PATTERN.test(haystack);
  const isStyleOnly = (category === "documentation" || category === "localization") && STYLE_ONLY_PATTERN.test(haystack);
  const hasConcreteDocsLocalizationEvidence =
    (category === "documentation" || category === "localization") && hasConcreteDocsLocalizationEvidenceText(haystack);
  const isPositive = POSITIVE_PATTERN.test(haystack) || (category === "testing" && TESTING_POSITIVE_PATTERN.test(haystack));
  const focus = resolveFocus(category, haystack, isStyleOnly, hasConcreteDocsLocalizationEvidence);
  const testingFocus = category === "testing" ? resolveTestingFocus(focus, isPositive) : undefined;
  const evidenceStrength = resolveEvidenceStrength(category, focus, haystack, isSpeculative, hasConcreteDocsLocalizationEvidence);

  return {
    category,
    focus,
    testingFocus,
    evidenceStrength,
    isSpeculative,
    isStyleOnly,
    isPositive,
    dropReason: resolveDropReason(category, haystack, testingFocus, isPositive),
  };
}

export function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const deduped = new Map<string, ReviewFinding>();

  for (const finding of findings.map(normalizeFinding)) {
    const key = createFindingKey(finding);
    const current = deduped.get(key);

    if (!current) {
      deduped.set(key, finding);
      continue;
    }

    deduped.set(key, mergeFinding(current, finding));
  }

  return [...deduped.values()].sort(compareFindings);
}

export function calibrateFinding(finding: ReviewFinding): ReviewFinding | null {
  const normalized = normalizeFinding(finding);
  const calibration = inspectFinding(normalized);

  if (calibration.dropReason) {
    return null;
  }

  let severity = normalized.severity;

  if (calibration.isSpeculative) {
    severity = demoteSeverity(severity);
  }

  if (calibration.category === "testing") {
    severity = calibrateTestingSeverity(normalized, calibration, severity);
  } else if (calibration.category === "documentation" || calibration.category === "localization") {
    if (calibration.isStyleOnly) {
      severity = lowerSeverity(severity, "nitpick");
    } else {
      if (calibration.isSpeculative) {
        severity = lowerSeverity(severity, "minor");
      }

      if (!allowsMajorDocsLocalization(normalized)) {
        severity = lowerSeverity(severity, "minor");
      }
    }
  }

  return {
    ...normalized,
    severity,
    category: calibration.category,
    metadata: {
      ...calibration,
      originalSeverity: normalized.severity,
    },
  };
}

export function calibrateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return dedupeFindings(findings)
    .map(calibrateFinding)
    .filter((finding): finding is ReviewFinding => finding !== null)
    .sort(compareFindings);
}

export function resolveReviewLevel(reviewLevel?: ReviewLevel | string): ReviewLevel {
  if (reviewLevel === "light" || reviewLevel === "normal" || reviewLevel === "deep") {
    return reviewLevel;
  }

  return "normal";
}

export function filterFindingsByReviewLevel(
  findings: ReviewFinding[],
  reviewLevel: ReviewLevel | string = "normal",
): ReviewFinding[] {
  const threshold = REVIEW_LEVEL_THRESHOLDS[resolveReviewLevel(reviewLevel)];
  return calibrateFindings(findings).filter((finding) => compareSeverity(finding.severity, threshold) >= 0);
}

export function selectVerdict(findings: ReviewFinding[]): ReviewVerdict {
  const deduped = calibrateFindings(findings);
  return deduped.some((finding) => finding.severity === "critical" || finding.severity === "major")
    ? "REQUEST_CHANGES"
    : "COMMENT";
}

export function buildReviewSummary(
  findings: ReviewFinding[],
  summaryText: string,
  coverageNote: string,
  topRisks: string[],
): ReviewSummary {
  const deduped = calibrateFindings(findings);
  const filteredTopRisks = filterTopRisks(topRisks, deduped);
  const severityCounts: ReviewSummary["severityCounts"] = {
    critical: 0,
    major: 0,
    minor: 0,
    nitpick: 0,
  };

  for (const finding of deduped) {
    severityCounts[finding.severity] += 1;
  }

  return {
    verdict: selectVerdict(deduped),
    summary: filterSummaryText(summaryText, deduped, filteredTopRisks),
    coverageNote,
    topRisks: filteredTopRisks,
    severityCounts,
  };
}

export function formatFindingForDisplay(finding: ReviewFinding): string {
  return `[${finding.severity.toUpperCase()}] ${finding.title}: ${finding.body}`;
}

function createFindingKey(finding: ReviewFinding): string {
  const normalizedTitle = finding.title.toLowerCase().replace(/\W+/g, " ").trim();
  return [finding.path.toLowerCase(), finding.line ?? "file", normalizeFindingCategory(finding), normalizedTitle].join("::");
}

function mergeFinding(left: ReviewFinding, right: ReviewFinding): ReviewFinding {
  const highest =
    SEVERITY_ORDER.indexOf(left.severity) >= SEVERITY_ORDER.indexOf(right.severity) ? left.severity : right.severity;

  return {
    ...left,
    severity: highest,
    body: left.body.length >= right.body.length ? left.body : right.body,
  };
}

function compareFindings(left: ReviewFinding, right: ReviewFinding): number {
  const pathDelta = left.path.localeCompare(right.path);
  if (pathDelta !== 0) {
    return pathDelta;
  }

  const leftLine = left.line ?? Number.MAX_SAFE_INTEGER;
  const rightLine = right.line ?? Number.MAX_SAFE_INTEGER;
  if (leftLine !== rightLine) {
    return leftLine - rightLine;
  }

  return left.title.localeCompare(right.title);
}

function compareSeverity(left: ReviewSeverity, right: ReviewSeverity): number {
  return SEVERITY_ORDER.indexOf(left) - SEVERITY_ORDER.indexOf(right);
}

function demoteSeverity(severity: ReviewSeverity): ReviewSeverity {
  return SEVERITY_ORDER[Math.max(0, SEVERITY_ORDER.indexOf(severity) - 1)] ?? "nitpick";
}

function lowerSeverity(left: ReviewSeverity, right: ReviewSeverity): ReviewSeverity {
  return compareSeverity(left, right) <= 0 ? left : right;
}

function raiseSeverity(left: ReviewSeverity, right: ReviewSeverity): ReviewSeverity {
  return compareSeverity(left, right) >= 0 ? left : right;
}

function resolveFocus(
  category: ReviewFindingCategory,
  haystack: string,
  isStyleOnly: boolean,
  hasConcreteDocsLocalizationEvidence: boolean,
): ReviewFindingFocus {
  if (category === "testing") {
    if (TESTING_BREAKAGE_PATTERN.test(haystack)) {
      return "execution_breakage";
    }

    if (TESTING_COVERAGE_GAP_PATTERN.test(haystack)) {
      return "coverage_gap";
    }

    if (TESTING_MIGRATION_NOISE_PATTERN.test(haystack)) {
      return "migration_cleanup";
    }
  }

  if (TESTING_MIGRATION_NOISE_PATTERN.test(haystack)) {
    return "style_consistency";
  }

  if (hasConcreteDocsLocalizationEvidence) {
    return "functional";
  }

  if (/\b(terminology|glossary)\b/i.test(haystack)) {
    return "terminology";
  }

  if (/\b(tone|friendlier|voice)\b/i.test(haystack)) {
    return "tone";
  }

  if (/\b(clarity|readability)\b/i.test(haystack)) {
    return "clarity";
  }

  if (isStyleOnly) {
    return "style";
  }

  return "general";
}

function resolveEvidenceStrength(
  category: ReviewFindingCategory,
  focus: ReviewFindingFocus,
  haystack: string,
  isSpeculative: boolean,
  hasConcreteDocsLocalizationEvidence: boolean,
): ReviewEvidenceStrength {
  if (category === "testing") {
    if (focus === "execution_breakage" && TESTING_BREAKAGE_PATTERN.test(haystack)) {
      return "concrete";
    }

    if (focus === "coverage_gap" && TESTING_CONCRETE_COVERAGE_GAP_PATTERN.test(haystack)) {
      return "concrete";
    }

    return isSpeculative ? "speculative" : "none";
  }

  if (category === "documentation" || category === "localization") {
    return hasConcreteDocsLocalizationEvidence ? "concrete" : "speculative";
  }

  return isSpeculative ? "speculative" : "concrete";
}

function hasConcreteDocsLocalizationEvidenceText(value: string): boolean {
  return CONCRETE_DOCS_LOCALIZATION_PATTERN.test(value);
}

function allowsMajorDocsLocalization(finding: ReviewFinding): boolean {
  const haystack = [finding.title, finding.body, finding.category, finding.path].join("\n");
  return hasConcreteDocsLocalizationEvidenceText(haystack) && HIGH_IMPACT_DOCS_LOCALIZATION_PATTERN.test(haystack);
}

function filterTopRisks(topRisks: string[], findings: ReviewFinding[]): string[] {
  if (findings.length === 0) {
    return [];
  }

  const findingTokens = createFindingTokenSet(findings);

  const filtered = topRisks
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !SPECULATIVE_PATTERN.test(item))
    .filter((item) => !isTestingNoiseSummary(item, findings))
    .filter((item) => {
      const tokens = tokenize(item);
      return tokens.length === 0 || tokens.some((token) => findingTokens.has(token));
    })
    .slice(0, 5);

  if (filtered.length > 0) {
    return filtered;
  }

  return findings.slice(0, 5).map((finding) => finding.title);
}

function filterSummaryText(summaryText: string, findings: ReviewFinding[], topRisks: string[]): string {
  const trimmed = summaryText.trim();

  if (!trimmed) {
    return buildFallbackSummary(findings);
  }

  if (findings.length === 0) {
    return buildFallbackSummary(findings);
  }

  if (SPECULATIVE_PATTERN.test(trimmed) || isTestingNoiseSummary(trimmed, findings)) {
    return buildFallbackSummary(findings);
  }

  const findingTokens = createFindingTokenSet(findings);
  const riskTokens = new Set(topRisks.flatMap((risk) => tokenize(risk)));
  const summaryTokens = tokenize(trimmed);
  const alignsWithFindings =
    summaryTokens.length === 0 || summaryTokens.some((token) => findingTokens.has(token) || riskTokens.has(token));

  return alignsWithFindings ? trimmed : buildFallbackSummary(findings);
}

function buildFallbackSummary(findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return "No surviving calibrated findings.";
  }

  return findings
    .slice(0, 3)
    .map((finding) => finding.title.trim())
    .filter(Boolean)
    .join("; ");
}

function createFindingTokenSet(findings: ReviewFinding[]): Set<string> {
  return new Set(findings.flatMap((finding) => tokenize([finding.path, finding.title, finding.body, finding.category].join(" "))));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
}

function calibrateTestingSeverity(
  finding: ReviewFinding,
  calibration: ReviewFindingCalibration,
  severity: ReviewSeverity,
): ReviewSeverity {
  const haystack = [finding.title, finding.body, finding.category, finding.path].join("\n");
  const testingFocus = calibration.testingFocus ?? resolveTestingFocus(calibration.focus, calibration.isPositive);

  if (testingFocus === "execution") {
    return calibration.evidenceStrength === "concrete" && TESTING_BREAKAGE_PATTERN.test(haystack)
      ? raiseSeverity(severity, "major")
      : lowerSeverity(severity, "minor");
  }

  if (testingFocus === "coverage") {
    const criticalCoverageGap =
      /\b(critical suite(?:s)? not running|critical .*suite.*no longer (?:run|runs|execute|executes)|critical .*coverage|zero tests?|never ran)\b/i.test(
        haystack,
      );

    return criticalCoverageGap ? raiseSeverity(severity, "major") : lowerSeverity(severity, "minor");
  }

  if (testingFocus === "cleanup" || testingFocus === "style") {
    return lowerSeverity(severity, "nitpick");
  }

  if (TESTING_MIGRATION_NOISE_PATTERN.test(haystack)) {
    return lowerSeverity(severity, "nitpick");
  }

  return lowerSeverity(severity, "minor");
}

function isTestingNoiseSummary(summary: string, findings: ReviewFinding[]): boolean {
  if (!SUMMARY_TESTING_NOISE_PATTERN.test(summary)) {
    return false;
  }

  return !findings.some((finding) => {
    if (finding.category !== "testing") {
      return false;
    }

    const testingFocus = finding.metadata?.testingFocus;
    return testingFocus === "execution" || testingFocus === "coverage";
  });
}

function resolveTestingFocus(focus: ReviewFindingFocus, isPositive: boolean): ReviewTestingFocus {
  if (isPositive) {
    return "positive";
  }

  if (focus === "execution_breakage") {
    return "execution";
  }

  if (focus === "coverage_gap") {
    return "coverage";
  }

  if (focus === "migration_cleanup") {
    return "cleanup";
  }

  if (focus === "style_consistency" || focus === "style") {
    return "style";
  }

  return "general";
}

function resolveDropReason(
  category: ReviewFindingCategory,
  haystack: string,
  testingFocus: ReviewTestingFocus | undefined,
  isPositive: boolean,
): ReviewFindingCalibration["dropReason"] {
  if (isPositive || testingFocus === "positive") {
    return "positive_observation";
  }

  if (NON_ISSUE_PATTERN.test(haystack)) {
    return "non_issue";
  }

  if (
    category === "documentation" &&
    /\.mdx?\b/i.test(haystack) &&
    /\b(testing|jest|mocha|migration log|coverage|suite|integration test|app boot|helpers?)\b/i.test(haystack) &&
    !hasConcreteDocsLocalizationEvidenceText(haystack)
  ) {
    return "non_issue";
  }

  if (category === "testing" && (testingFocus === "cleanup" || testingFocus === "style")) {
    return "non_issue";
  }

  if (
    category === "testing" &&
    testingFocus === "general" &&
    TEST_FILE_PATH_PATTERN.test(haystack) &&
    !TESTING_BREAKAGE_PATTERN.test(haystack) &&
    !TESTING_COVERAGE_GAP_PATTERN.test(haystack)
  ) {
    return "non_issue";
  }

  if (
    category === "testing" &&
    testingFocus === "coverage" &&
    TESTING_CONCRETE_COVERAGE_GAP_PATTERN.test(haystack) &&
    !/\b(critical|auth|authorization|security|acl|access control|learning progress|never ran|zero tests?|whole suite|entire suite)\b/i.test(
      haystack,
    )
  ) {
    return "non_issue";
  }

  if (category === "testing" && TESTING_GENERAL_ADVICE_PATTERN.test(haystack)) {
    return "non_issue";
  }

  return undefined;
}
