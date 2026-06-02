# Restrict Queue Discovery to Recent, Non-Draft, Not-Yet-Reviewed PRs

## Summary
- Change automatic PR queue discovery so it only picks up PRs that:
  - are open
  - are requested for the current reviewer
  - were updated in the last 7 days
  - are not in draft state
  - have not already been reviewed by the current GitHub user
- Apply these rules only to queue discovery. Keep explicit `--repo --pr` targeting unchanged so a specific PR can still be reviewed on demand, even if it is old, draft, or already reviewed.
- Keep the existing tool-specific “already reviewed this head SHA” skip logic in place as a second layer.

## Key Changes
- Tighten GitHub search discovery in the GitHub client.
  - Add an `updated:>=YYYY-MM-DD` term for the last 7 days.
  - Add a “not already reviewed by me” search qualifier to the `gh search prs` query.
  - Preserve existing `org`, `repo`, and explicit PR-number filtering behavior.
- Resolve the authenticated GitHub login once per run.
  - Add a small GitHub client method that fetches the current user login via `gh api user`.
  - Use that login for review-author comparisons in fallback skip logic.
- Add safety-net filtering after metadata/review lookup.
  - Skip any queued PR whose metadata reports `isDraft=true`.
  - Skip any queued PR that already has at least one review authored by the current user, regardless of review state or whether it was posted by this tool.
  - Keep the existing skip for “current head already reviewed by this tool” as an additional check.
- Update runtime messages.
  - Log explicit skip reasons for `draft` and `already reviewed by current user`.
  - Keep “No pull requests to review” behavior, but it now reflects the narrower queue.

## Public Interfaces
- No new CLI flags.
- No change to existing command shapes.
- Internal type additions only:
  - discovery filtering/types should carry the fixed 7-day cutoff
  - review-skip logic should accept the authenticated user login
  - skip metadata may be extended to expose “reviewed by current user” separately from “reviewed current head by this tool” if that improves clarity

## Test Plan
- GitHub client tests:
  - discovery query includes the 7-day `updated:` constraint
  - discovery query excludes PRs already reviewed by `@me`
  - authenticated-user lookup parses the current login correctly
  - existing discovery retry behavior still works
- Main-flow tests:
  - queue discovery skips draft PRs
  - queue discovery skips PRs already reviewed by the current user
  - queue discovery still skips PRs whose current head was already reviewed by this tool
  - explicit `--repo --pr` still processes a draft, old, or already-reviewed PR
  - skip messages identify whether the reason was `draft`, `already reviewed by current user`, or `current head already reviewed`
- Regression tests:
  - org/repo-scoped queue discovery still works
  - no-PR behavior remains unchanged except for the narrower filter set

## Assumptions
- “Updated in the last week” means updated within the last 7 calendar days from the current run date.
- “Reviewed by the current user” means any GitHub PR review already submitted by the authenticated `gh` user, not only reviews posted by this tool.
- These restrictions apply only to automatic queue discovery, not explicit PR targeting.
- Default behavior is fixed in code for now; no configurability is added in this change.
