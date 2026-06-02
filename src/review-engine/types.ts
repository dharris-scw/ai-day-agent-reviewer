export type ReviewSeverity = "critical" | "major" | "minor" | "nitpick";
export type ReviewLevel = "light" | "normal" | "deep";
export type ReviewFindingCategory =
  | "security"
  | "correctness"
  | "documentation"
  | "localization"
  | "testing"
  | "maintainability"
  | "performance"
  | "usability"
  | "ci"
  | "other";
export type ReviewFindingFocus =
  | "general"
  | "functional"
  | "style"
  | "terminology"
  | "tone"
  | "clarity"
  | "execution_breakage"
  | "coverage_gap"
  | "migration_cleanup"
  | "style_consistency";
export type ReviewTestingFocus = "execution" | "coverage" | "cleanup" | "style" | "positive" | "general";
export type ReviewEvidenceStrength = "none" | "speculative" | "concrete";
export type ReviewFindingDropReason = "positive_observation" | "non_issue";

export const REVIEW_LEVEL_THRESHOLDS: Record<ReviewLevel, ReviewSeverity> = {
  light: "major",
  normal: "minor",
  deep: "nitpick",
};

export type ReviewVerdict = "COMMENT" | "REQUEST_CHANGES";

export interface ReviewFinding {
  path: string;
  line: number | null;
  severity: ReviewSeverity;
  title: string;
  body: string;
  category: string;
  metadata?: ReviewFindingCalibration;
}

export interface ReviewFindingCalibration {
  category: ReviewFindingCategory;
  focus: ReviewFindingFocus;
  testingFocus?: ReviewTestingFocus;
  evidenceStrength: ReviewEvidenceStrength;
  isSpeculative: boolean;
  isStyleOnly: boolean;
  isPositive: boolean;
  dropReason?: ReviewFindingDropReason;
  originalSeverity?: ReviewSeverity;
}

export interface ReviewSummary {
  verdict: ReviewVerdict;
  summary: string;
  coverageNote: string;
  topRisks: string[];
  severityCounts: Record<ReviewSeverity, number>;
}

export interface ReviewResult {
  coverage: CoveragePlan;
  findings: ReviewFinding[];
  summary: ReviewSummary;
}

export interface RepositoryContextFile {
  path: string;
  content: string;
}

export interface ChangedFileInput {
  path: string;
  content: string;
  patch: string;
  additions?: number;
  deletions?: number;
  context?: string;
}

export interface PullRequestReviewInput {
  owner: string;
  repo: string;
  title: string;
  description?: string;
  reviewLevel?: ReviewLevel;
  baseSha: string;
  headSha: string;
  changedFiles: ChangedFileInput[];
  repositoryContext?: RepositoryContextFile[];
  coverage?: Partial<CoverageOptions>;
}

export interface CoverageOptions {
  maxFiles: number;
  maxLines: number;
}

export interface CoverageCandidate {
  path: string;
  additions: number;
  deletions: number;
}

export interface CoveragePlan {
  mode: "full" | "reduced";
  note: string;
  reviewedPaths: string[];
  skippedPaths: string[];
  totalFiles: number;
  totalChangedLines: number;
}

export interface ReviewEngineModel {
  generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T>;
}

export interface StructuredGenerationRequest<T> {
  system: string;
  user: string;
  schemaName: string;
  schema: JsonSchema;
  validate: (value: unknown) => T;
  retryHint?: string;
}

export interface JsonSchema {
  type: "object";
  additionalProperties?: boolean;
  properties: Record<string, unknown>;
  required?: readonly string[];
}

export interface RepositoryBrief {
  architectureNotes: string[];
  riskAreas: string[];
}

export interface FileReviewModelResponse {
  findings: ReviewFinding[];
}

export interface SynthesisModelResponse {
  summary: string;
  topRisks: string[];
}
