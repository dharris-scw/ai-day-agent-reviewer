# agent-review

`agent-review` is a local TypeScript CLI that reviews GitHub pull requests using `gh` for GitHub access and OpenAI for code review.

For npm distribution, install the scoped package `@dharris-scw/ai-day-agent-reviewer`. It exposes the `agent-review` command.

It is designed for a single authenticated user running it from their own machine. In `--dry-run` mode it writes one timestamped JSON artifact at the end of the run in the repo root and reports the saved file path without posting anything.

## What It Does

- Discovers pull requests requested either directly for the current user or for GitHub teams the user belongs to
- Clones each PR into a temporary workspace under `/tmp/agent-review`
- Builds review context from the diff, changed files, and selected repository files
- Calls OpenAI to generate structured findings
- Calibrates and filters findings by review level
- Shows visual review progress with a spinner and task list in TTY mode
- Prepares inline comments plus a final review summary
- Writes one aggregate dry-run review artifact as JSON in the repo root
- Stores reviewed head SHAs in `~/.agent-review/state.json`

## Queue Discovery Rules

Automatic queue discovery only picks up PRs that are:

- open
- review-requested either directly for the current GitHub user or for a GitHub team the user belongs to
- updated within the last 7 days
- not draft
- not already reviewed by the authenticated GitHub user

Explicit targeting bypasses those queue rules:

```bash
agent-review --repo owner/repo --pr 123 --dry-run --model gpt-4.1-mini
```

That path still reviews the requested PR even if it is old, draft, or already reviewed.

## Requirements

- Node.js 20+
- `gh` installed and authenticated
- `OPENAI_API_KEY` set
- an OpenAI model provided via `--model` or `OPENAI_MODEL`

Authenticate GitHub first:

```bash
gh auth login
gh auth status
```

Set OpenAI environment variables:

```bash
export OPENAI_API_KEY=your_key_here
export OPENAI_MODEL=gpt-4.1-mini
```

## Install

```bash
npm install --global @dharris-scw/ai-day-agent-reviewer
```

After installation, run the CLI as:

```bash
agent-review --dry-run --model gpt-4.1-mini
```

If you prefer not to install globally, use the package with `npx`:

```bash
npx @dharris-scw/ai-day-agent-reviewer --dry-run --model gpt-4.1-mini
```

## Usage

Dry runs keep terminal output concise and save the full review artifact to disk:

Review the current queue without posting:

```bash
agent-review --dry-run --model gpt-4.1-mini
```

Review one specific PR:

```bash
agent-review --repo SecureCodeWarrior/platform --pr 9993 --dry-run --model gpt-4.1-mini
```

Scope queue discovery to an org:

```bash
agent-review --org SecureCodeWarrior --dry-run --model gpt-4.1-mini
```

Run a real review submission:

```bash
agent-review --repo owner/repo --pr 123 --model gpt-4.1-mini
```

### Dry-Run Output

- TTY mode shows a spinner plus a live task list.
- Non-TTY mode emits deterministic append-only snapshots for logs and tests.
- Dry-run mode writes one file like `agent-review-dry-run-20260612-031415-016.json` in the repo root after all reviews finish.

Example:

```text
/ Reviewing pull requests
[>] Tighten validation around dry runs [widget#42]
[ ] Refresh queue filters [gadget#7]

[x] Tighten validation around dry runs [widget#42] (1 finding) - COMMENT
[x] Refresh queue filters [gadget#7] (0 findings) - COMMENT

findings written to /path/to/repo/agent-review-dry-run-20260612-031415-016.json
```

### Review Levels

- `light`: only blocking-level findings survive
- `normal`: default; includes actionable non-blocking findings
- `deep`: broadest output, including lower-severity findings

Example:

```bash
agent-review --repo owner/repo --pr 123 --dry-run --model gpt-4.1-mini --review-level normal
```

## CLI Flags

- `--repo owner/repo`
- `--pr 123`
- `--org your-org`
- `--dry-run`
- `--no-approve`
- `--concurrency 2`
- `--max-files 40`
- `--max-lines 1500`
- `--model gpt-4.1-mini`
- `--review-level light|normal|deep`

`--dry-run` writes one aggregate JSON review artifact to the current repo root at the end of the run and does not mark the PR head as reviewed in tool state.

## Behavior Notes

- The tool never auto-approves by default.
- It submits `REQUEST_CHANGES` only when surviving findings include `major` or `critical`.
- It skips re-review when the current PR head SHA was already reviewed by this tool.
- Skipped PRs remain visible in the task list with the skip reason.
- TTY runs use an in-place spinner and task list; non-TTY runs use deterministic append-only snapshots.
- Dry runs do not print raw payload JSON to stdout and do not mark reviewed state.
- Large PRs are reviewed in reduced-coverage mode using the configured file/line guardrails.
- If GitHub diff retrieval is too large, it falls back to the pull-files API.

## Manual Release Preparation

Use this checklist to prepare the npm release artifacts for `@dharris-scw/ai-day-agent-reviewer` without publishing anything:

1. Update the release metadata in `package.json` in your release branch or worktree:
   - set `"name"` to `@dharris-scw/ai-day-agent-reviewer`
   - keep the `"bin"` entry exposing `agent-review`
   - bump `"version"` for the intended release
2. Rebuild the distributable files:

```bash
npm run build
```

3. Inspect the package contents that would be published:

```bash
npm pack --dry-run
```

4. Produce the tarball locally for handoff or smoke testing:

```bash
npm pack
```

5. Smoke test the packed artifact in a clean directory before publishing:

```bash
npm install --global ./dharris-scw-ai-day-agent-reviewer-<version>.tgz
agent-review --help
```

Stop there. This flow prepares and validates the npm package but does not run `npm publish`.

## Development

Install local dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Typecheck:

```bash
npm run check
```

Run tests:

```bash
npm test
```

## Current Limitations

- Review quality is still model-dependent and can be noisy, especially on translation-heavy or migration-heavy PRs.
- Queue discovery intentionally excludes draft PRs and PRs you have already reviewed; use `--repo` and `--pr` when you want to force a review anyway.
- The tool currently supports OpenAI only. There is no multi-provider abstraction.
