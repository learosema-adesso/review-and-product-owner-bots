# Scripts

This folder contains various scripts :)

## Quality Assurance

QA is done by eslint, and BullyBot :D

BullyBot is a mean code reviewer, a classical senior tech bully. Don't take him 100% serious.
He's programmed to be salty. What he looks at, how to silence him and how to set him up is in
[bullybot/README.md](bullybot/README.md).

## Product Owner

The Product Owner is BullyBot's friendly counterpart: run it manually with a rough feature direction
and it files well-formed tickets with acceptance criteria on the backlog and the project board.
A second manual workflow, **Product Owner cleanup**, finds stale issues (implemented, duplicate,
superseded or inactive), explains why and closes or labels them. It is a dry run unless you switch
that off, and it caps how many issues it touches (`dry_run`, `stale_days`, `max_issues`).
A third one, **Product Owner refine**, takes a ticket (or scans for candidates) and fills in a missing
description or acceptance criteria, rewrites unclear text only when the context settles it, asks
questions otherwise, and proposes splitting tickets that are too big (inputs: `issue`, `max_issues`,
`dry_run`, `apply`). Setup, inputs and troubleshooting are in
[productowner/README.md](productowner/README.md).

## Tests

```sh
npm test --prefix scripts
```
