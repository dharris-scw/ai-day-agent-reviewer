# agent-review

`agent-review` is a local TypeScript CLI that reviews GitHub pull requests using `gh` for GitHub access and OpenAI for code review.

It is designed for a single authenticated user running it from their own machine. In `--dry-run` mode it prints the exact GitHub review payloads it would submit without posting anything.

## What It Does

- Discovers pull requests requested for the current user
- Clones each PR into a temporary workspace under `/tmp/agent-review`
- Builds review context from the diff, changed files, and selected repository files
- Calls OpenAI to generate structured findings
- Calibrates and filters findings by review level
- Prepares inline comments plus a final review summary
- Stores reviewed head SHAs in `~/.agent-review/state.json`

## Queue Discovery Rules

Automatic queue discovery only picks up PRs that are:

- open
- review-requested for the current GitHub user
- updated within the last 7 days
- not draft
- not already reviewed by the authenticated GitHub user

Explicit targeting bypasses those queue rules:

```bash
node dist/src/index.js --repo owner/repo --pr 123 --dry-run --model gpt-4.1-mini
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

## Install and Build

```bash
npm install
npm run build
```

## Usage

Review the current queue without posting:

```bash
node dist/src/index.js --dry-run --model gpt-4.1-mini
```

Review one specific PR:

```bash
node dist/src/index.js --repo SecureCodeWarrior/platform --pr 9993 --dry-run --model gpt-4.1-mini
```

Scope queue discovery to an org:

```bash
node dist/src/index.js --org SecureCodeWarrior --dry-run --model gpt-4.1-mini
```

Run a real review submission:

```bash
node dist/src/index.js --repo owner/repo --pr 123 --model gpt-4.1-mini
```

### Review Levels

- `light`: only blocking-level findings survive
- `normal`: default; includes actionable non-blocking findings
- `deep`: broadest output, including lower-severity findings

Example:

```bash
node dist/src/index.js --repo owner/repo --pr 123 --dry-run --model gpt-4.1-mini --review-level normal
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

## Behavior Notes

- The tool never auto-approves by default.
- It submits `REQUEST_CHANGES` only when surviving findings include `major` or `critical`.
- It skips re-review when the current PR head SHA was already reviewed by this tool.
- Large PRs are reviewed in reduced-coverage mode using the configured file/line guardrails.
- If GitHub diff retrieval is too large, it falls back to the pull-files API.

## Development

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
