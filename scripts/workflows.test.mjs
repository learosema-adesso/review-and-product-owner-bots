import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The reusable workflows find out which version of themselves they run with a shell step. Every
 * workflow carries its own copy, so the step is taken out of each file and run against a stub
 * `gh`, to check what it decides without GitHub.
 */

const WORKFLOWS = join(import.meta.dirname, '..', '.github', 'workflows');
const DEFAULT_REPOSITORY = 'learosema-adesso/review-and-product-owner-bots';

/** The `run:` script of the step "Find the version of the scripts", as it is in the workflow file. */
function versionScript(file) {
  const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split('\n');
  const step = lines.findIndex((l) => l.includes('name: Find the version of the scripts'));
  assert.notEqual(step, -1, `${file} has no step "Find the version of the scripts"`);
  const run = lines.findIndex((l, i) => i > step && /^\s+run: \|\s*$/.test(l));
  const indent = lines[run].match(/^\s*/)[0].length;
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    body.push(line.slice(indent + 2));
  }
  return body.join('\n');
}

/** Runs the script with a stub `gh` that prints `ghOutput` (or fails). */
function run(file, { ghOutput, ghFails = false, scriptsRef = 'v1' }) {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(
    join(dir, 'gh'),
    ghFails
      ? '#!/bin/sh\necho "HTTP 403" >&2\nexit 1\n'
      : `#!/bin/sh\ncat <<'JSON'\n${ghOutput}\nJSON\n`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const output = join(dir, 'output');
  writeFileSync(output, '');
  try {
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', versionScript(file)], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'someone/consumer',
        GITHUB_RUN_ID: '42',
        GITHUB_OUTPUT: output,
        GH_TOKEN: 'x',
        WORKFLOW_FILE: file,
        SCRIPTS_REF: scriptsRef,
      },
      encoding: 'utf8',
    });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(/=(.*)/s).slice(0, 2)),
    );
    return { ...result, outputs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const referenced = (...workflows) =>
  JSON.stringify({
    referenced_workflows: workflows.map(([path, sha]) => ({
      path,
      sha,
      ref: 'x',
    })),
  });
// Only the reusable workflows: the folder also holds workflows of this repository itself (callers).
const FILES = readdirSync(WORKFLOWS)
  .filter((f) => f.endsWith('.yml'))
  .filter((f) => /^\s{2}workflow_call:/m.test(readFileSync(join(WORKFLOWS, f), 'utf8')));

test('there are the four reusable workflows, each with the step', () => {
  assert.deepEqual(FILES.sort(), [
    'bullybot.yml',
    'product-owner-cleanup.yml',
    'product-owner-refine.yml',
    'product-owner.yml',
  ]);
});

for (const file of FILES) {
  test(`${file}: takes repository and commit of its own file from the run`, () => {
    const r = run(file, {
      ghOutput: referenced([
        `${DEFAULT_REPOSITORY}/.github/workflows/${file}@refs/tags/v1`,
        'abc123',
      ]),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.outputs, {
      repository: DEFAULT_REPOSITORY,
      sha: 'abc123',
    });
    assert.match(r.stdout, /Scripts: learosema-adesso\/review-and-product-owner-bots at abc123/);
    assert.doesNotMatch(r.stdout, /warning/);
  });

  test(`${file}: ignores the other workflows of the same repository, even with a similar name`, () => {
    const others = FILES.filter((f) => f !== file).map((f) => [
      `${DEFAULT_REPOSITORY}/.github/workflows/${f}@refs/tags/v1`,
      `wrong-${f}`,
    ]);
    const r = run(file, {
      ghOutput: referenced(...others, [
        `${DEFAULT_REPOSITORY}/.github/workflows/${file}@refs/tags/v1`,
        'right',
      ]),
    });
    assert.deepEqual(r.outputs, {
      repository: DEFAULT_REPOSITORY,
      sha: 'right',
    });
  });

  test(`${file}: works for a fork or a renamed repository`, () => {
    const r = run(file, {
      ghOutput: referenced([
        `someone-else/my-fork/.github/workflows/${file}@refs/heads/main`,
        'f0rk',
      ]),
    });
    assert.deepEqual(r.outputs, {
      repository: 'someone-else/my-fork',
      sha: 'f0rk',
    });
  });

  test(`${file}: falls back to scripts_ref with a warning if the API fails or knows nothing`, () => {
    for (const options of [
      { ghFails: true },
      { ghOutput: '{}' },
      { ghOutput: referenced() },
      {
        ghOutput: referenced(['other/repo/.github/workflows/other.yml@refs/heads/x', 's']),
      },
    ]) {
      const r = run(file, { ...options, scriptsRef: 'v1.2.3' });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.outputs, {
        repository: DEFAULT_REPOSITORY,
        sha: 'v1.2.3',
      });
      assert.match(r.stdout, /::warning::Could not find out which version of .* is running/);
    }
  });
}
