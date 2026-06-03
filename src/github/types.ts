export interface RepositoryRef {
  owner: string;
  name: string;
  host?: string;
}

export interface PullRequestRef {
  repository: RepositoryRef;
  number: number;
}

export interface PullRequestDiscoveryFilters {
  org?: string;
  repo?: string;
  pr?: number;
}

export interface AuthenticatedGitHubUser {
  login: string;
}

export interface AuthenticatedGitHubTeam {
  organizationLogin: string;
  slug: string;
}

export interface PullRequestCandidate extends PullRequestRef {
  title: string;
  url: string;
}

export interface PullRequestFile {
  path: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  status?: string;
  patch?: string;
  previousPath?: string;
}

export interface PullRequestMetadata extends PullRequestRef {
  title: string;
  url: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  baseSha: string;
  headSha: string;
  changedFiles: PullRequestFile[];
  isDraft?: boolean;
}

export type ReviewSeverity = 'critical' | 'major' | 'minor' | 'nitpick';
export type ReviewVerdict = 'COMMENT' | 'REQUEST_CHANGES';

export interface ReviewFinding {
  path?: string;
  line?: number;
  title: string;
  body: string;
  severity: ReviewSeverity;
  category?: string;
}

export interface ExistingReviewSummary {
  id: number;
  state: string;
  body: string;
  submittedAt?: string;
  authorLogin?: string;
}

export interface SkipMetadata {
  currentHeadSha: string;
  reviewedHeadShas: string[];
  alreadyReviewedCurrentHead: boolean;
  latestReviewedAt?: string;
}

export interface PreparedLineComment {
  body: string;
  path: string;
  line: number;
  side: 'RIGHT';
  subject_type: 'line';
}

export interface PreparedFileComment {
  body: string;
  path: string;
  subject_type: 'file';
}

export interface PreparedSummaryNote {
  body: string;
}

export interface PreparedReviewPayload {
  method: 'POST';
  endpoint: string;
  body: Record<string, unknown>;
}

export interface PreparedReviewSubmission {
  lineComments: PreparedLineComment[];
  fileComments: PreparedFileComment[];
  summaryNotes: PreparedSummaryNote[];
  review: PreparedReviewPayload;
  requests: PreparedReviewPayload[];
}

export interface SubmitReviewInput {
  pullRequest: PullRequestRef;
  headSha: string;
  diff: string;
  summary: string;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  dryRun?: boolean;
}

export interface SubmitReviewResult {
  dryRun: boolean;
  payloads: PreparedReviewPayload[];
}
