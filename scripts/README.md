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

## AI provider

Both bots use Gemini by default. Any service with an **OpenAI-compatible chat completions API** works
too. The provider is chosen with repository settings (**Settings → Secrets and variables →
Actions**), no code change:

| Name           | Kind     | Meaning                                                                            |
| -------------- | -------- | ---------------------------------------------------------------------------------- |
| `LLM_API_KEY`  | secret   | API key. With the default provider the old `GEMINI_API_KEY` secret works as well.  |
| `LLM_PROVIDER` | variable | `gemini` (default) or `openai`.                                                    |
| `LLM_MODEL`    | variable | Model name. Required for `openai`. For `gemini` it defaults to `gemini-3.6-flash`. |
| `LLM_BASE_URL` | variable | `openai` only: defaults to `https://api.openai.com/v1`.                            |

For `gemini`, `GEMINI_MODEL`, `GEMINI_PROJECT_ID` and `GEMINI_LOCATION` (variables) still work, and
`LLM_MODEL` wins over `GEMINI_MODEL` if both are set. An existing Gemini setup needs no change.
Empty values count as not set.

**Examples for `LLM_PROVIDER=openai`**

| Service    | `LLM_BASE_URL`                                                               | `LLM_MODEL`                                  |
| ---------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| OpenAI     | (leave empty)                                                                | a chat model of your account                 |
| OpenRouter | `https://openrouter.ai/api/v1`                                               | `<vendor>/<model>` as listed by OpenRouter   |
| Mistral    | `https://api.mistral.ai/v1`                                                  | a Mistral chat model                         |
| Ollama     | `http://<host>:11434/v1`                                                     | a model you pulled; the key can be any value |
| vLLM       | `http://<host>:8000/v1`                                                      | the model the server was started with        |
| Azure      | the OpenAI-compatible endpoint of your resource, see the Azure documentation | the name of your deployment                  |

The bots run on GitHub's runners, so a local server (`localhost`) is only reachable from a
self-hosted runner or if the server is exposed. Services without authentication still need
`LLM_API_KEY` to be set, any value will do.

**What to expect from other models**

- The bots ask for JSON that matches a schema (`response_format`) and describe the schema in the
  prompt as well. The answer is checked, a malformed one is retried once, and then the run fails
  with a message that says why. Support for structured output **varies between compatible
  services and models**: if you see that message often, the model is a poor fit.
- **Weaker models give worse results.** BullyBot needs exact line numbers and has to find real
  problems without inventing any, the Product Owner has to follow a long list of rules. Expect
  wrong line numbers, false findings and missed acceptance criteria from small models, and read the
  first runs with that in mind.
- Rate limits and server errors (429, 500, 503) are retried up to three times, a request that takes
  longer than three minutes is aborted.
- Some models only accept their default `temperature`; the bots always send one. If the service
  rejects it, its error message is shown in the job log.
- The `openai` provider is covered by tests against a fake server. It has not been run against every
  service, so treat a new service as an experiment and start with a dry run (Product Owner) or a
  throwaway PR (BullyBot).

## Tests

```sh
npm test --prefix scripts
```
