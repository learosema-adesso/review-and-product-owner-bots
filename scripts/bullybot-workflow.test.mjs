import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Fix it" with a push runs the code of the pull request (the tests). The rule that keeps this safe is
 * about the structure of the workflow: the job that runs that code has no secrets and no token that can
 * write, and the token that can write only exists in jobs that never run it. The workflow is read as text.
 */

const FILE = join(import.meta.dirname, '..', '.github', 'workflows', 'bullybot.yml');
const text = readFileSync(FILE, 'utf8');

/** The text of every job, by name. */
function jobs() {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === 'jobs:');
  const result = {};
  let name = null;
  for (const line of lines.slice(start + 1)) {
    const header = line.match(/^ {2}([a-z][\w-]*):\s*$/);
    if (header) {
      name = header[1];
      result[name] = [];
    } else if (name) result[name].push(line);
  }
  return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.join('\n')]));
}

/** The lines that are shell code: the body of every `run:` step. */
function shellLines(job) {
  const lines = job.split('\n');
  const code = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    if (m[2] && m[2] !== '|') {
      code.push(m[2]);
      continue;
    }
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].match(/^\s*/)[0].length <= indent) break;
      code.push(lines[j]);
    }
  }
  return code;
}

const all = jobs();

test('the workflow has the three jobs of "fix it" with a push', () => {
  assert.deepEqual(Object.keys(all), ['bully', 'fix-test', 'fix-finish']);
});

test('the job that runs the tests has no secrets and a read-only token', () => {
  const job = all['fix-test'];
  assert.match(job, /^ {4}permissions:\n {6}contents: read\n(?! {6}\S)/m, 'only contents: read');
  for (const forbidden of [
    /secrets\./,
    /create-github-app-token/,
    /github-token:/,
    /PRODUCT_OWNER/,
    /LLM_API_KEY|GEMINI_API_KEY/,
    /app\.outputs\.token/,
    /id-token/,
  ])
    assert.doesNotMatch(job, forbidden);
  // the code of the pull request is checked out without leaving the token in its git config
  assert.equal((job.match(/persist-credentials: false/g) ?? []).length, 2);
});

test('the tests run on the repository without our scripts, and only this job runs the test command', () => {
  const job = all['fix-test'];
  assert.ok(
    job.indexOf('rm -rf _bots') < job.indexOf('FIX_TEST_COMMAND: '),
    'scripts are removed first',
  );
  assert.ok(job.indexOf('bullybot-apply.mjs') < job.indexOf('rm -rf _bots'));
  assert.equal((text.match(/FIX_TEST_COMMAND/g) ?? []).length, 2); // the variable and its use, both in fix-test
  assert.equal((job.match(/FIX_TEST_COMMAND/g) ?? []).length, 2);
  assert.doesNotMatch(all.bully, /FIX_TEST_COMMAND|fix_test_command\s*\}\}.*run/);
  assert.doesNotMatch(all['fix-finish'], /FIX_TEST_COMMAND/);
});

test('the write token exists only after the tests, and not in the job that runs them', () => {
  assert.match(all['fix-finish'], /uses: actions\/create-github-app-token@/);
  assert.match(all['fix-finish'], /needs: \[bully, fix-test\]/);
  // without the token the job fails: no fallback to the workflow token for the push
  assert.doesNotMatch(all['fix-finish'], /steps\.app\.outputs\.token \|\|/);
  assert.doesNotMatch(all['fix-finish'], /continue-on-error/);
  assert.match(all['fix-finish'], /github-token: \$\{\{ steps\.app\.outputs\.token \}\}/);
});

test('data from job outputs and inputs reaches the shell only through the environment', () => {
  for (const [name, job] of Object.entries(all))
    for (const line of shellLines(job))
      assert.doesNotMatch(line, /\$\{\{/, `${name} puts an expression into a script: ${line}`);
});

test('a fix is only proposed with a test command and an app token, and the jobs wait for a proposal', () => {
  assert.match(
    all.bully,
    /BULLYBOT_FIX_PUSH: \$\{\{ inputs\.fix_test_command != '' && steps\.app\.outputs\.token != '' \}\}/,
  );
  assert.match(all['fix-test'], /if: \$\{\{ needs\.bully\.outputs\.fix_pending == 'true' \}\}/);
  assert.match(
    all['fix-finish'],
    /if: \$\{\{ always\(\) && needs\.bully\.outputs\.fix_pending == 'true' \}\}/,
  );
  // no job of its own concurrency group: the push starts a new review of the pull request
  assert.doesNotMatch(all['fix-test'], /concurrency:/);
  assert.doesNotMatch(all['fix-finish'], /concurrency:/);
});

test('the jobs of "fix it" never use a cache that code of the pull request could poison', () => {
  for (const name of ['fix-test', 'fix-finish']) {
    const job = all[name];
    assert.doesNotMatch(job, /actions\/cache/, name);
    assert.doesNotMatch(job, /^\s+cache:/m, name);
    // setup-node caches the package manager by itself, unless it is told not to
    const steps = job.split(/^ {6}- /m).filter((s) => /uses: actions\/setup-node@/.test(s));
    assert.ok(steps.length > 0, `${name} sets up Node.js`);
    for (const step of steps) assert.match(step, /package-manager-cache: false/, name);
  }
});
