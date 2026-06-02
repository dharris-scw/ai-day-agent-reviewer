import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateStore } from "../../src/state/store.js";

test("state store persists reviewed heads", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-review-state-"));
  const store = createStateStore(join(root, "state.json"));
  assert.equal(await store.getReviewedHead("github.com/org/repo#1"), undefined);
  await store.setReviewedHead("github.com/org/repo#1", "abc123");
  assert.equal(await store.getReviewedHead("github.com/org/repo#1"), "abc123");
});

test("state store shouldReview compares the saved head sha", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-review-state-"));
  const store = createStateStore(join(root, "state.json"));
  const target = {
    host: "github.com",
    owner: "org",
    repo: "repo",
    prNumber: 7
  };

  assert.equal(await store.shouldReview(target, "head-1"), true);
  await store.markReviewed(target, "head-1");
  assert.equal(await store.shouldReview(target, "head-1"), false);
  assert.equal(await store.shouldReview(target, "head-2"), true);
});
