import type { ChangedFileInput, CoverageOptions, CoveragePlan } from "./types.js";

export const DEFAULT_COVERAGE_OPTIONS: CoverageOptions = {
  maxFiles: 40,
  maxLines: 1500,
};

const HIGH_RISK_PATTERNS = [
  /^src\//i,
  /(^|\/)(server|api|auth|migrations?|infra|terraform|helm|k8s)(\/|$)/i,
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle|Gemfile(\.lock)?|requirements(\.[\w-]+)?\.txt)$/i,
];

export function planReviewCoverage(
  files: ChangedFileInput[],
  overrides: Partial<CoverageOptions> = {},
): CoveragePlan {
  const options: CoverageOptions = {
    ...DEFAULT_COVERAGE_OPTIONS,
    ...overrides,
  };

  const totalChangedLines = files.reduce((sum, file) => {
    return sum + (file.additions ?? 0) + (file.deletions ?? 0);
  }, 0);

  const ranked = [...files].sort(compareCoveragePriority);
  const isReduced = ranked.length > options.maxFiles || totalChangedLines > options.maxLines;
  const selected = isReduced ? ranked.slice(0, options.maxFiles) : ranked;
  const skipped = isReduced ? ranked.slice(options.maxFiles) : [];

  const note = isReduced
    ? `Reduced coverage: reviewed ${selected.length} of ${files.length} changed files (${options.maxFiles}-file / ${options.maxLines}-line guardrails) with priority on high-risk paths.`
    : `Full coverage across ${files.length} changed file${files.length === 1 ? "" : "s"}.`;

  return {
    mode: isReduced ? "reduced" : "full",
    note,
    reviewedPaths: selected.map((file) => file.path),
    skippedPaths: skipped.map((file) => file.path),
    totalFiles: files.length,
    totalChangedLines,
  };
}

function compareCoveragePriority(left: ChangedFileInput, right: ChangedFileInput): number {
  const riskDelta = scoreFileRisk(right.path) - scoreFileRisk(left.path);
  if (riskDelta !== 0) {
    return riskDelta;
  }

  const lineDelta =
    (right.additions ?? 0) +
    (right.deletions ?? 0) -
    ((left.additions ?? 0) + (left.deletions ?? 0));
  if (lineDelta !== 0) {
    return lineDelta;
  }

  return left.path.localeCompare(right.path);
}

function scoreFileRisk(path: string): number {
  let score = 0;

  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(path)) {
      score += 10;
    }
  }

  if (/\.(sql|tf|yaml|yml|json|toml)$/i.test(path)) {
    score += 2;
  }

  return score;
}
