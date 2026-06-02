import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_STATE_PATH } from "../config.js";
import type { PersistedReviewState, ReviewStateStore, ReviewTarget } from "./types.js";

export class StateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateStoreError";
  }
}

export interface StateStore extends ReviewStateStore {
  getReviewedHead(key: string): Promise<string | undefined>;
  setReviewedHead(key: string, headSha: string): Promise<void>;
}

export function createStateStore(statePath = DEFAULT_STATE_PATH): StateStore {
  return {
    async getReviewedHeadSha(target) {
      return this.getReviewedHead(makeKey(target));
    },
    async shouldReview(target, headSha) {
      const existing = await this.getReviewedHeadSha(target);
      return existing !== headSha;
    },
    async markReviewed(target, headSha) {
      await this.setReviewedHead(makeKey(target), headSha);
    },
    async getReviewedHead(key) {
      const state = await readStateFile(statePath);
      return state.reviews[key];
    },
    async setReviewedHead(key, headSha) {
      const state = await readStateFile(statePath);
      state.reviews[key] = headSha;
      await persistStateFile(statePath, state);
    }
  };
}

async function readStateFile(statePath: string): Promise<PersistedReviewState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedReviewState>;
    if (parsed.version !== undefined && parsed.version !== 1) {
      throw new StateStoreError(`Unsupported state version: ${parsed.version}`);
    }
    if (parsed.reviews !== undefined && typeof parsed.reviews !== "object") {
      throw new StateStoreError("State file is invalid");
    }
    return {
      version: 1,
      reviews: parsed.reviews ?? {}
    };
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return { version: 1, reviews: {} };
    }
    if (error instanceof SyntaxError) {
      throw new StateStoreError("State file is not valid JSON");
    }
    throw error;
  }
}

async function persistStateFile(statePath: string, state: PersistedReviewState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, statePath);
}

function makeKey(target: ReviewTarget): string {
  return `${target.host}/${target.owner}/${target.repo}#${target.prNumber}`;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
