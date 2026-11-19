# Review and Product Owner bots

Two AI helpers for the pull requests and the backlog of a GitHub repository. You install them with a
few lines of workflow in your own repository, nothing is copied.

- **BullyBot** reviews every pull request like a salty senior developer. He comments on single
  lines, checks the pull request against the acceptance criteria of the issues it closes, answers
  when you reply, and can suggest a fix on request. The friction is intended, he simulates a
  demanding reviewer. Don't take him 100% seriously. [Read more](scripts/bullybot/README.md)
- **Product Owner** is his friendly counterpart. Three workflows you start by hand:
  - **Product Owner** turns a rough idea into well-formed tickets with acceptance criteria, on the
    backlog and the project board.
  - **Product Owner cleanup** finds implemented, duplicate, superseded and inactive issues, says why
    and closes or labels them.
  - **Product Owner refine** completes tickets that lack a description or acceptance criteria and
    proposes splitting tickets that are too big.

  [Read more](scripts/productowner/README.md)

Both use Gemini by default, or any service with an OpenAI-compatible API, see
[AI provider](scripts/README.md#ai-provider).

## How it works

This repository contains four [reusable workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
(`.github/workflows/bullybot.yml`, `product-owner.yml`, `product-owner-cleanup.yml`,
`product-owner-refine.yml`). Your repository only has a small **caller** workflow per bot, copied
from [`examples/`](examples). It decides the triggers and the inputs and passes everything on:

```yaml
jobs:
  bullybot:
    uses: learosema-adesso/review-and-product-owner-bots/.github/workflows/bullybot.yml@v1
    secrets: inherit
```

The called workflow checks out its own scripts from this repository, at exactly the commit of the
workflow you called. You never have to copy a script into your repository.

## Quick start

You need to do this once per repository. Everything marked optional can be left out.

### 1. Create a GitHub App (optional for BullyBot, recommended)

With an app, the bots write their comments and tickets as `<name>[bot]`, BullyBot can resolve
review threads, and the Product Owner can set Status, Size and Priority on an organization board.
Without an app BullyBot still reviews, using the workflow token, but he cannot resolve threads, and
the Product Owner cannot touch the board (see the
[Product Owner setup](scripts/productowner/README.md#2-access-to-the-board-and-issue-fields) for the
fallback with a personal access token).

Create it under **Settings → Developer settings → GitHub Apps → New GitHub App** (of your
organization or your account). Turn **Webhook → Active** off. Permissions:

| Permission                 | Level      | Needed for                                                    |
| -------------------------- | ---------- | ------------------------------------------------------------- |
| Repository: Pull requests  | Read/write | BullyBot: reviews, comments, thread replies                   |
| Repository: Contents       | Read/write | BullyBot: GitHub only lets an app resolve threads with it     |
| Repository: Issues         | Read/write | Product Owner: tickets and comments                           |
| Organization: Projects     | Read/write | Product Owner: Status and Size on an organization board       |
| Organization: Issue fields | Read       | Product Owner: reads the Priority field (organization boards) |

Then generate a private key, note the **Client ID** and **install the app on every repository**
that uses the bots. Details and screenshots of the form:
[Product Owner setup, option A](scripts/productowner/README.md#option-a-a-github-app-recommended).

### 2. Add the secrets

In the repository: **Settings → Secrets and variables → Actions → Secrets**.

| Secret                    | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| `LLM_API_KEY`             | API key of the AI service (`GEMINI_API_KEY` works for Gemini too)   |
| `PRODUCT_OWNER_CLIENT_ID` | Client ID of the GitHub App (if you use one)                        |
| `PRODUCT_OWNER_APP_KEY`   | The whole private key of the app, including the `BEGIN`/`END` lines |

Prefer repository secrets. Organization secrets are shared by many repositories, so a leak reaches
all of them, and on the free plan they do not reach private repositories at all. If you use them,
choose **selected repositories**, never all.

### 3. Set the variables (all optional)

Same page, tab **Variables**.

| Variable                    | Meaning                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `PROJECT_URL`               | URL of the project board for the Product Owner, for example `https://github.com/orgs/<org>/projects/1`. Without it, no board is touched. |
| `LLM_PROVIDER`              | `gemini` (default) or `openai` for any OpenAI-compatible service                                                                         |
| `LLM_MODEL`, `LLM_BASE_URL` | Model and endpoint for `openai`, optional model for `gemini`                                                                             |
| `PRODUCT_SOURCE_PATHS`      | Directories with the source of your app, for example `apps/web/src, libs`. Default: `src`, `projects` and `packages` are detected.       |
| `BULLYBOT_FIX_MAX_LINES`    | Longest fix BullyBot suggests on request, default 40                                                                                     |

### 4. Add the caller workflows

Copy the files you want from [`examples/`](examples) to `.github/workflows/` of your repository:

| File                                                              | What it gives you                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| [`bullybot.yml`](examples/bullybot.yml)                           | BullyBot reviews every pull request                  |
| [`product-owner.yml`](examples/product-owner.yml)                 | Run by hand with an idea, it files the tickets       |
| [`product-owner-cleanup.yml`](examples/product-owner-cleanup.yml) | Run by hand, tidies the backlog (dry run by default) |
| [`product-owner-refine.yml`](examples/product-owner-refine.yml)   | Run by hand, completes and splits tickets            |

Optional: with `fix_test_command` in the `with:` block of the BullyBot caller, a `fix it` makes him
push the fix to the branch of the pull request after your tests passed on it
([how it works](scripts/bullybot/README.md#letting-him-push-the-fix-optional)).

Open a pull request and BullyBot will look at it. Start the Product Owner workflows from the
**Actions** tab, and begin with `dry_run` on.

## Versions

The examples use `@v1`, which always points to the latest release 1.x.y. You can pin more strictly:

| You write            | You get                                                  |
| -------------------- | -------------------------------------------------------- |
| `@v1`                | Fixes and features of version 1, but no breaking changes |
| `@v1.0.0`            | Exactly this release                                     |
| `@<full commit sha>` | Exactly this commit, the strictest option                |

The scripts always match the workflow you pinned. To find that out, the called workflow asks the
GitHub API which commit of itself it is running. For that, **your caller workflow must grant
`actions: read`** (the examples do). Without it, GitHub rejects the run at startup, instead of
silently running other scripts.

## For public repositories

- **Fork pull requests get no secrets** from GitHub, so BullyBot cannot review them. That is
  intended, do not switch the trigger to `pull_request_target` to get around it.
- **Anyone can comment** in a public repository, and every reaction of BullyBot costs tokens. The
  example caller of BullyBot only reacts to review comments of the owner, members and collaborators.
  Keep that condition. The Product Owner workflows start by hand and need write access.
- **Set a quota** (budget or rate limit) on the API key at your AI provider, and prefer a key
  that is only used for this.
- The private key of the GitHub App can create tokens for every repository the app is installed
  on. Install it only where you trust the workflows.

## Documentation

- [BullyBot](scripts/bullybot/README.md): what he reviews, his follow-ups, `fix it`, troubleshooting
- [Product Owner](scripts/productowner/README.md): setup, the three workflows, troubleshooting
- [AI provider](scripts/README.md#ai-provider): Gemini, OpenAI-compatible services and what to expect

## Development

```sh
npm ci --prefix scripts
npm test --prefix scripts
npx prettier@3.8.1 --check .
```

Every change is a pull request with a ticket, checked by CI and reviewed by BullyBot himself.

### Releasing

Publish a GitHub release for a tag like `v1.2.0`. The workflow
[`major-version-tag.yml`](.github/workflows/major-version-tag.yml) then moves the floating tag `v1` to
it, as long as it is the newest `v1.x.y` release. Pre-releases (`v1.3.0-beta.1`) and fixes for an
older line do not move it. The exact tags (`v1.2.0`) are protected by a ruleset and never change.

## License

[MIT](LICENSE)
