# Product Owner

The Product Owner is a friendly bot that turns a rough idea into backlog tickets. You tell it
roughly what you want to build, it looks at what already exists, and it files small, well-formed
tickets with acceptance criteria. It is BullyBot's nicer colleague, and the two work together:
the criteria it writes are exactly what BullyBot checks pull requests against.

It runs only when you start it. It never reacts to issues, comments or pull requests on its own.

## What it does

1. **Reads the project.** Open and closed issues, labels, milestones, the README, project
   guidelines (`.github/bullybot.md`, `CONTRIBUTING.md`, `CLAUDE.md`, ...), recent commits, the file
   tree and the source of the app on the default branch.
2. **Plans.** It cuts your direction into small tickets that fit into one pull request each. Ideas
   that already exist in the code or the backlog are not turned into tickets, they are listed as
   skipped with a reason.
3. **Checks for overlap.** For every ticket it first lists the existing issues that touch the same
   area and how they relate. A ticket that duplicates an existing issue is not created (it shows
   up under "Discarded drafts" with the issue number). Tickets that build on or relate to existing
   issues get an "Overlaps with existing issues" section in their notes.
4. **Checks its own work.** Drafts without acceptance criteria and duplicates of existing issues
   or of other drafts are discarded. Labels, milestones, sizes and issue references that do not
   exist are dropped, so nothing is made up.
5. **Creates the issues.** Each ticket is linked as a sub-issue of an existing open epic, or of a
   new epic if the direction is big enough to deserve one.
6. **Sets Priority and Size** (Urgent to Low, XS to XL), so nobody has to debate XS versus S in a
   meeting, and **puts the tickets on the board** in **Backlog**.
7. **Reports** what it did, what it skipped and what went wrong in the job summary of the run.

### What a ticket looks like

```markdown
## Goal

As a team member, I want to vote on proposed meeting times, so that we find a slot everybody can attend.

## Acceptance criteria

- [ ] A member can vote once per proposed time
- [ ] Changing a vote replaces the earlier one
- [ ] Voting works with the keyboard and the options have accessible labels

## Out of scope

- Ranking the options

## Notes

Related: #42
```

The `## Acceptance criteria` checkbox list is the format BullyBot reads.

## Setup

You need to do this once.

### 1. Gemini API key

Add the repository secret `GEMINI_API_KEY` (**Settings → Secrets and variables → Actions → New
repository secret**). It is the same secret BullyBot uses, so if BullyBot works, this is done.

Optional environment overrides, read by both bots: `GEMINI_MODEL`, `GEMINI_PROJECT_ID` and
`GEMINI_LOCATION`.

### 2. Access to the board and issue fields

GitHub's built-in workflow token cannot write to GitHub Projects and cannot read the organization's
issue fields, so Status, Size and Priority need more than the default token. Without it, the Product
Owner still creates and links the issues, it just does not set these fields (and tells you so in
the job log). There are two ways, in this order of preference:

#### Option A: a GitHub App (recommended)

An app is not tied to a person, its tokens expire after about an hour, and nothing has to be renewed.
It works for boards owned by an **organization**. With an app, the issues are also created by the
app (shown as `<app name>[bot]`) instead of `github-actions`.

1. As an organization owner, open **Organization settings → Developer settings → GitHub Apps → New
   GitHub App**.
2. Name it (for example `panic-planner-product-owner`). The form requires a homepage URL; use the
   URL of this repository. Leave Callback URL and Setup URL empty, leave the OAuth, device flow and
   "expire user authorization tokens" options unchecked, and **uncheck Webhook → Active**. Under
   "Where can this GitHub App be installed?" choose **Only on this account**.
3. Set these permissions, and no others:
   - **Repository permissions → Issues: Read and write** (creates issues, sets Priority)
   - **Repository permissions → Contents: Read** (reads the README and the source of the app)
   - **Organization permissions → Projects: Read and write** (Status and Size on the board)
   - **Organization permissions → Issue fields: Read** (finds the Priority field)
4. Create the app. On its settings page, note the **Client ID**, then **Generate a private key**
   (a `.pem` file is downloaded).
5. Open **Install App**, install it on the organization and choose **Only select repositories** with
   this repository.
6. In the repository, add two secrets (**Settings → Secrets and variables → Actions**):
   - `PRODUCT_OWNER_CLIENT_ID`: the Client ID
   - `PRODUCT_OWNER_APP_KEY`: the full content of the `.pem` file, including the `BEGIN` and `END` lines
7. Delete the `.pem` file from your computer. Run the workflow; the step "Create GitHub App token"
   should run, and the issues should be authored by the app.

The workflow creates the token at the start of every run, limits it to this repository, and
GitHub revokes it when the job ends. The private key never appears in the log.

#### Option B: a personal access token (fallback)

Used if the app secrets are not set. Tokens expire, so set a reminder for the expiry date: a run
with an expired token shows up as a warning.

**Fine-grained token (tested):**

1. Open **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
   and choose **Generate new token**.
2. Choose the organization as the **resource owner**, an expiry, and **Only select repositories**
   with this repository. The organization may need to allow fine-grained tokens and approve the
   request.
3. Set these permissions, and no others:
   - **Organization permissions → Projects: Read and write** (Status and Size on the board)
   - **Organization permissions → Issue fields: Read** (finds the Priority field)
   - **Repository permissions → Issues: Read and write** (sets the Priority value on an issue)
4. In the repository, add the token as the secret `PROJECT_TOKEN`.

Fine-grained tokens cannot access boards owned by a user account. For those, use a classic token.

**Classic token (not tested with Priority):** the scopes **`project`** and **`repo`** should cover
the same. It is coarser, because it reaches every repository and project you can access.

With a token, the issues themselves are created with the workflow token; the token is used for the
board and for setting Priority.

### 3. Project board

The board is configured with the repository variable `PROJECT_URL` (**Settings → Secrets and
variables → Actions → Variables**), for example `https://github.com/users/<login>/projects/1` or
`https://github.com/orgs/<org>/projects/1`. There is deliberately no default: if it is not set,
tickets are still created but not added to any board, and the job summary says so.

The board needs these single-select fields; missing ones are skipped with a warning:

| Field  | Options used by the bot   |
| ------ | ------------------------- |
| Status | `Backlog`                 |
| Size   | `XS`, `S`, `M`, `L`, `XL` |

**Priority is different.** It is not a board field but the organization's **Priority issue field**
(options `Urgent`, `High`, `Medium`, `Low`), which is set on the issue itself and then shows up on
every board. The bot sets it right after creating the issue, with the app token or `PROJECT_TOKEN`
if there is one (the workflow token alone is usually not allowed to read issue fields). This needs a
repository that belongs to an organization with that issue field (**Organization settings → Issue fields**). In a personal repository, Priority is
skipped with a warning.

Matching is case-insensitive. If your board already adds new issues automatically (a project
workflow), that works fine; the bot sets the fields on the existing item.

### 4. Repository settings

- Actions must be enabled for the repository. The workflow declares the permissions it needs
  (`contents: read`, `issues: write`) itself, no change to the default workflow permissions is needed.
- The labels and milestones you want the bot to use must already exist. It never creates labels
  or milestones, it only picks from the existing ones (`epic` is used for new epics).

## Running it

**Actions → Product Owner → Run workflow**

| Input         | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `direction`   | Required. Your rough idea, a sentence or a few paragraphs (max 4000 characters). |
| `max_tickets` | Upper limit of tickets to create. Default 6, hard limit 12.                      |
| `dry_run`     | Only show the plan in the job summary, create nothing.                           |

Good directions describe the outcome and who benefits, not the implementation:

> Teams should be able to propose several meeting times and vote on them. Keep it accessible.

**Where to find the result:** the plan is printed in the job log of the run (the table of tickets,
what was skipped and why, what was discarded, and any problems), and the full text of every planned
ticket is in the collapsed group "Planned tickets in full". The same report is on the run's summary
page. If a plan surprises you, the group "Raw answer of the model" shows what the model returned
before it was checked.

Start with a **dry run** the first time and after changing the prompt: read the plan in the job
summary, then run again without `dry_run`. Two runs with the same direction can produce different
tickets, so don't expect the second run to match the dry run word for word. Duplicates of issues
that already exist are filtered, which makes a repeated run safe, though not free.

Only one run at a time is allowed, further runs wait in the queue.

## Troubleshooting

| Symptom                                      | Likely cause and fix                                                                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY secret is missing!`          | Add the secret, see setup step 1.                                                                                                                                                        |
| Warning: `PROJECT_URL is not set ...`        | Set the repository variable, see step 3. Issues were created but not put on a board.                                                                                                     |
| Warning: `No board token is configured ...`  | Set up the GitHub App or the token, see step 2. Issues were created but not put on the board.                                                                                            |
| Step "Create GitHub App token" fails         | The client ID or private key is wrong (use the whole `.pem` content), or the app is not installed on this repository. See option A.                                                      |
| Warning: `Project board not usable: ...`     | The token has no access to the board, expired, or `PROJECT_URL` is wrong.                                                                                                                |
| Warning: `Priority was not set on any issue` | The token lacks a permission (`Resource not accessible by integration`), see the permissions of the app or token in step 2, or the organization has no Priority issue field, see step 3. |
| Warning: `board has no option for Size=M`    | The board field or option is missing or named differently, see step 3.                                                                                                                   |
| `No ticket could be created`                 | Every ticket failed. The job summary lists the errors, usually missing permissions.                                                                                                      |
| No tickets, only a summary                   | The direction was vague, or everything already exists. The summary says what it needs.                                                                                                   |
| Ticket has no labels or milestone            | The model named one that does not exist, so it was dropped on purpose.                                                                                                                   |

## Files

| File                                  | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `.github/workflows/product-owner.yml` | The manually triggered workflow.                                        |
| `scripts/productowner.mjs`            | Orchestration: persona, prompt, creating issues, run report.            |
| `scripts/productowner/context.mjs`    | Reads the product (README, guidelines, source) from the default branch. |
| `scripts/productowner/backlog.mjs`    | Loads and formats issues, labels and milestones.                        |
| `scripts/productowner/tickets.mjs`    | Validates the model's plan and renders issue bodies.                    |
| `scripts/productowner/project.mjs`    | Adds issues to the board and sets its fields.                           |
| `scripts/lib/gemini.mjs`              | Gemini client with retries, shared with BullyBot.                       |

## Tests

```sh
npm test --prefix scripts
```

The tests use a fake GitHub client and a fake model, so they need neither network nor API keys.
