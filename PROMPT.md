# Goal

Implement the visual CLI and dry-run artifact work described in [PLAN.md](./PLAN.md). Treat `PLAN.md` as the source of truth for scope, behavior, JSON shape, and test expectations.

## Required outcomes

- Create and work on a new branch named `feature/visual-cli-dry-run-artifacts`.
- Replace the current line-by-line CLI progress output with a renderer that shows:
  - one global spinner while work is active
  - a task list keyed by `owner/repo#pr`
  - task states for `queued`, `reviewing`, `skipped`, and `complete`
  - completed tasks with a tick and a findings suffix like `(3 findings)`
- Keep skipped PRs visible in the task list with the correct reason.
- In `--dry-run` mode, stop printing payloads/findings to stdout. Instead, write one timestamped JSON artifact per reviewed PR in the repo root using the schema defined in `PLAN.md`, and report the saved file path in the CLI output.
- Preserve stable task ordering under concurrency and keep a deterministic non-TTY fallback.
- Update tests and README to match the new behavior.

## Constraints

- Do not add new CLI flags unless strictly necessary.
- Keep existing review payload generation behavior intact unless `PLAN.md` explicitly requires otherwise.
- Real runs must still mark PR heads as reviewed; dry runs must not.
- Prefer no new dependencies unless a tiny terminal UI dependency is clearly justified.

## Execution expectations

- Read `PLAN.md` first and follow it closely.
- Make the implementation decision-complete relative to that plan.
- Run the relevant tests and report any gaps or failures.
