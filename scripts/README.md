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

### Tests

```sh
npm test --prefix scripts
```
