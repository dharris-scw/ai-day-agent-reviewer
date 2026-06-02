export interface ReviewTarget {
  host: string;
  owner: string;
  repo: string;
  prNumber: number;
}

export interface PersistedReviewState {
  version: 1;
  reviews: Record<string, string>;
}

export interface ReviewStateStore {
  getReviewedHeadSha(target: ReviewTarget): Promise<string | undefined>;
  shouldReview(target: ReviewTarget, headSha: string): Promise<boolean>;
  markReviewed(target: ReviewTarget, headSha: string): Promise<void>;
}
