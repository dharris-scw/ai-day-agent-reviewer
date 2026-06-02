export type ReviewLevel = 'light' | 'normal' | 'deep';

export interface EnvironmentSource {
  OPENAI_MODEL?: string;
  GH_HOST?: string;
  AGENT_REVIEW_CONCURRENCY?: string;
  AGENT_REVIEW_MAX_FILES?: string;
  AGENT_REVIEW_MAX_LINES?: string;
}

export interface RepoRef {
  host: string;
  owner: string;
  repo: string;
}

export interface ParsedCliArguments {
  repo?: string;
  pr?: number;
  org?: string;
  dryRun: boolean;
  noApprove: boolean;
  concurrency?: number;
  maxFiles?: number;
  maxLines?: number;
  model?: string;
  reviewLevel?: ReviewLevel;
}

export interface CliOptions {
  repo?: RepoRef;
  pr?: number;
  org?: string;
  dryRun: boolean;
  noApprove: boolean;
  concurrency: number;
  maxFiles: number;
  maxLines: number;
  model: string;
  reviewLevel: ReviewLevel;
}
