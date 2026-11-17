# Scripts

This folder contains various scripts :)

## Quality Assurance

QA is done by eslint, and bullybot :D

BullyBot is a mean code reviewer, a classical senior tech bully. 
Don't take him 100% serious. He's programmed to be salty.

### What BullyBot looks at

- The PR diff (the only thing it comments on), plus as context: the full content of changed files,
  existing tests of changed files, the repository file list, `package.json`, PR description and commits.
- Linked issues: everything the PR closes (`Closes #12`) and issues mentioned in the PR description.
  The checkbox list under `## Acceptance criteria` is checked item by item: implemented? tested?
  The result is posted as a checklist comment that is updated on every push.
- Project guidelines from the base branch, if present: `.github/bullybot.md`, `CONTRIBUTING.md`,
  `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`. Put review rules for BullyBot in
  `.github/bullybot.md`.

Silence him by commenting `shut up` on the PR.

## Product Owner

The Product Owner is BullyBot's friendly counterpart: warm, calm and good at turning fuzzy ideas
into tickets a developer can pick up right away.

Run it from **Actions → Product Owner → Run workflow** and give it a rough direction, e.g.
"teams should be able to vote on meeting times". It then

1. reads the backlog (open and closed issues), labels, milestones, the README, project guidelines
   and the source of the app, so it knows what already exists,
2. cuts the direction into small vertical tickets with a user story, `## Acceptance criteria`
   (checkbox list, the same format BullyBot checks pull requests against), out-of-scope notes,
   labels, milestone, size and priority,
3. skips ideas that already exist and discards drafts that duplicate an issue,
4. creates the issues, links them as sub-issues of an existing epic (or a new one if the direction
   is big enough), and puts them on the project board with Status, Priority and Size.

Inputs: `direction` (required), `max_tickets` (default 6, at most 12) and `dry_run` (only shows the
plan in the job summary and creates nothing, a good way to try a new direction).

### Setup

- Secret `GEMINI_API_KEY`, same as BullyBot.
- Secret `PROJECT_TOKEN`: a personal access token with the `project` scope. It is only used for the
  board, the issues themselves are created with the workflow token. The default workflow token
  cannot write to GitHub Projects. Without it, tickets are still created, just not added to
  the board, and the job summary says so.
- Optional variable `PROJECT_URL` (e.g. `https://github.com/users/<login>/projects/1`).
  Defaults to the Panic Planner board.

Review the result on the board: the Product Owner only creates tickets in **Backlog**.

## Tests

```sh
npm test --prefix scripts
```
