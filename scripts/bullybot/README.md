# BullyBot

BullyBot is a mean code reviewer, a classic senior tech bully: salty, sarcastic, tired of
shortcuts. He reviews every pull request, checks it against the acceptance criteria of the issues
it closes, and follows up when you answer him. The friction is intentional, it simulates working
with a demanding reviewer. Don't take him 100% seriously.

Under the sarcasm he has rules: he pokes fun at code and shortcuts, never at people. He only
claims what he can verify in the diff, stays quiet when unsure, and admits it clearly when you
prove him wrong. His friendly colleague is the [Product Owner](../productowner/README.md), who
writes the tickets BullyBot checks pull requests against.

## What he does

### Reviews the diff

On every opened, updated, reopened or ready-for-review pull request he posts one review:

- A **summary** under a "👺 BullyBot" heading, including a one-line acceptance criteria verdict.
- Up to **8 inline comments**, each on a line of the diff, with a severity and a concrete fix.
  If there are more findings, the most severe ones are kept. Order of attention: bugs and edge
  cases, security, accessibility, missing or weak tests, then design.
- Missing tests have no line to attach to, so they are called out in the summary.

He only comments on lines of the diff. Everything else (full files, tests, issues) is context.

### Checks acceptance criteria

He finds the issues a PR is about: everything it closes (`Closes #12`) and issues mentioned in the
PR description (at most 5). From the checkbox list under `## Acceptance criteria` in each issue he
judges every criterion:

- **Implemented:** yes, partly or no
- **Tested:** yes, partly (only the happy path), no, or n/a (docs, manual checks, decisions)

The result is a single checklist comment on the PR that is **updated on every push**, not
re-posted. A PR without a linked issue gets a hint to add `Closes #<issue>`.

### Follows up on his own threads

When you reply to one of his review comments, he answers right away (without a full re-review) and
decides:

- **Fixed:** the code no longer has the problem.
- **Dispute accepted:** your reasoning is right. He says so clearly, names what he got wrong, and
  never raises the finding again.
- **Still open:** the problem stands, he says why and what would convince him.

The workflow token is not allowed to resolve review threads. When he considers a thread settled he
asks **you** to click "Resolve". Settled threads stay settled even if the thread is still open.
On every push he also re-checks his open threads against the new code.

### What he reads

- The PR diff, plus the full content of changed files, existing tests of changed files, the
  repository file list, `package.json`, the PR description and the commits. Lockfiles, binaries
  and build output are left out.
- Project rules from the **base branch** (so a PR can't rewrite its own review rules):
  `.github/bullybot.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`,
  `.github/copilot-instructions.md`. Put review rules for BullyBot in `.github/bullybot.md`.

Large PRs are cut down by priority, the least important context goes first (diff limit
120,000 characters, total context 250,000).

## When he stays quiet

- The PR is a **draft**: he waits for "ready for review".
- The PR was opened by a **bot** (Dependabot, Renovate, ...).
- Anybody comments **`shut up`** on the PR. To get him back, delete that comment.
- A reply lands in a thread he didn't start, or a comment was written by a bot.
- There are no new findings: he doesn't repeat old ones or post empty reviews.

## Setup

1. Add the repository secret `GEMINI_API_KEY` (**Settings → Secrets and variables → Actions → New
   repository secret**). Optional environment overrides: `GEMINI_MODEL`, `GEMINI_PROJECT_ID` and
   `GEMINI_LOCATION`.
2. That's it. The workflow in `.github/workflows/bullybot.yml` declares its own permissions
   (`contents: read`, `issues: read`, `pull-requests: write`).

Bot PRs never get repository secrets from GitHub, which is why the job doesn't even start for
them. The same goes for PRs from forks: without the secret he can't review them.

### Running him by hand

**Actions → Bullybot → Run workflow**, enter the PR number. Useful for PRs opened before he was
installed, or to repeat a review.

### Writing issues he can check

```markdown
## Goal

What this is about.

## Acceptance criteria

- [ ] One observable, testable statement per line
- [ ] Error paths and accessibility included
```

Only checkboxes under that heading count (also "Akzeptanzkriterien" or "Definition of done").
Without the heading, every checkbox in the issue is used. Sub-headings below it are part of the
section. Criteria that can't be tested automatically are marked n/a rather than failed.

## Troubleshooting

| Symptom                             | Likely cause and fix                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY secret is missing!` | Add the secret. PRs from forks and bots never get it.                                         |
| Nothing happens on a PR             | Draft PR, bot PR, or someone wrote `shut up`.                                                 |
| "No linked issue" hint              | Add `Closes #<issue>` to the PR description.                                                  |
| Criteria show as "not assessed"     | The model left them out. Push again or run the workflow by hand.                              |
| `AI Generation failed`              | Gemini was overloaded or returned nothing. He makes up to three attempts, run it again later. |
| He keeps raising something wrong    | Reply in the thread with the reason. If you're right he admits it.                            |
| Thread stays open after he conceded | Click "Resolve", the token isn't allowed to.                                                  |

## Files

| File                              | Purpose                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `.github/workflows/bullybot.yml`  | Triggers, permissions and concurrency.                                  |
| `scripts/bullybot.mjs`            | Orchestration: persona, prompts, thread follow-ups, posting the review. |
| `scripts/bullybot/diff.mjs`       | Splits and line-annotates the diff, finds related tests, skips noise.   |
| `scripts/bullybot/context.mjs`    | Gathers linked issues, files, guidelines and fits them into the budget. |
| `scripts/bullybot/acceptance.mjs` | Parses criteria and renders the checklist comment.                      |
| `scripts/bullybot/review.mjs`     | Finding selection, thread status and the sticky comment.                |
| `scripts/lib/gemini.mjs`          | Gemini client with retries, shared with the Product Owner.              |

## Tests

```sh
npm test --prefix scripts
```
