# Agent Code Reviewer

A fully autonomous CLI tool that performs comprehensive code reviews on GitHub PRs assigned to the user. Invoked on-demand, it processes the user's pending review queue across all repos — cloning codebases, exploring full context, and submitting inline comments with a summary review directly on GitHub.

## Core Workflow

1. **Discover** — Use `gh` CLI to find all PRs where the user is a requested reviewer
2. **Clone** — Ephemeral clone of each repo into a temp directory, checkout the PR branch
3. **Analyze** — Full codebase exploration using an AI agent (not just the diff)
4. **Review** — Submit a GitHub PR review with inline comments on specific lines + a summary
5. **Cleanup** — Remove the ephemeral clone

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Autonomy | Fully autonomous | Posts reviews without human confirmation |
| Discovery | `gh` CLI | No webhook infrastructure needed; user controls when it runs |
| Runtime | CLI on-demand | User invokes when ready to process review queue |
| Codebase | Ephemeral clones | No stale state, no disk management, clean environment each time |
| Context | Full codebase exploration | Understands architecture, not just the diff in isolation |
| Output | Inline + summary review | Actionable line-level feedback plus high-level assessment |
| Stack | TypeScript | Type safety, good ecosystem for CLI tools and GitHub APIs |

## Review Methodology

The agent performs a comprehensive review covering:

- **Correctness** — Logic errors, edge cases, missing error handling
- **Security** — Injection risks, auth issues, secret exposure, unsafe dependencies
- **Performance** — Unnecessary allocations, N+1 queries, missing indexes, algorithmic issues
- **Style & Maintainability** — Naming, complexity, duplication, readability
- **Architecture** — Design coherence with the existing codebase, coupling, abstraction level

Each comment includes a severity level (critical, major, minor, nitpick) so the PR author can prioritize.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  CLI Entry Point                                │
│  $ agent-review [--dry-run] [--repo=X] [--pr=N] │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  Discovery                                      │
│  gh pr list --search "review-requested:@me"     │
│  Returns: [{repo, pr_number, title, url}, ...]  │
└────────────────────┬────────────────────────────┘
                     │
                     ▼ (for each PR)
┌─────────────────────────────────────────────────┐
│  Clone & Setup                                  │
│  - Clone to /tmp/agent-review/<repo>-<pr>       │
│  - Fetch PR branch                              │
│  - Identify base..head diff                     │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  AI Review Agent                                │
│  - Explore codebase for architectural context   │
│  - Analyze each changed file in full context    │
│  - Generate inline comments with line numbers   │
│  - Produce summary verdict (approve / request   │
│    changes / comment only)                      │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  Submit                                         │
│  - POST review via GitHub API (gh api)          │
│  - Inline comments on specific diff lines       │
│  - Summary body with severity breakdown         │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  Cleanup                                        │
│  - rm -rf /tmp/agent-review/<repo>-<pr>         │
└─────────────────────────────────────────────────┘
```

## CLI Interface

```bash
# Review all pending PRs assigned to you
agent-review

# Review a specific PR
agent-review --repo=org/repo --pr=123

# Dry run — show what would be posted without submitting
agent-review --dry-run

# Filter to specific orgs
agent-review --org=my-company

# Control verdict behavior
agent-review --no-approve  # never auto-approve, only leave comments
```

## Key Technical Considerations

### Diff-to-Line Mapping
GitHub's review API requires comments to reference specific lines in the diff (not the file). The agent needs to map its findings back to diff hunk positions. This is a known pain point with the GitHub API.

### Rate Limiting
Processing many PRs in sequence could hit GitHub API rate limits. Consider:
- Sequential processing with backoff
- Batching API calls where possible
- Respecting `X-RateLimit-Remaining` headers

### Token/Cost Management
Full codebase exploration for large repos can consume significant LLM tokens. Options:
- Set a max token budget per review
- Use cheaper models for initial triage, expensive models for deep analysis
- Skip files that are clearly auto-generated or vendored

### Concurrency
Process multiple PRs in parallel (bounded concurrency) to reduce total wall-clock time.

## Open Questions

- Should the agent re-review PRs it has already reviewed if new commits are pushed?
- How to handle PRs with 50+ changed files — full review or summarize and focus on critical paths?
- Should it post a "reviewing..." comment immediately so the PR author knows it's in progress?
- What LLM to use for the review agent? (Claude, GPT-4, local model?)
- Should there be a config file per-repo (e.g., `.agent-review.yml`) for repo-specific rules?
- How to handle monorepos with multiple logical projects?
