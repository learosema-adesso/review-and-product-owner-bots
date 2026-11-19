import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The script that moves the floating major tag (v1) runs against real git repositories: a bare
 * "origin" and a clone of it, in a temporary folder that is removed afterwards.
 */

const SCRIPT = join(import.meta.dirname, '..', '.github', 'scripts', 'move-major-tag.sh');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Runs `body({ work, origin, commit, release, move })` in a fresh clone, then cleans up. */
function withRepo(body) {
  const dir = mkdtempSync(join(tmpdir(), 'major-tag-'));
  try {
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    git(dir, 'init', '--bare', '-b', 'main', origin);
    git(dir, 'clone', '-q', origin, work);
    let n = 0;
    // a new commit; `release(tag)` tags the current commit and pushes the tag, like a release does
    const commit = () => {
      writeFileSync(join(work, 'file'), String(++n));
      git(work, 'add', '.');
      git(work, 'commit', '-q', '-m', `commit ${n}`);
      return git(work, 'rev-parse', 'HEAD');
    };
    const release = (tag) => {
      git(work, 'tag', tag);
      git(work, 'push', '-q', 'origin', 'HEAD:main', `refs/tags/${tag}`);
    };
    const move = (tag) =>
      spawnSync('bash', [SCRIPT, tag], { cwd: work, env: ENV, encoding: 'utf8' });
    const remoteTag = (tag) => {
      const r = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`], {
        cwd: origin,
        env: ENV,
        encoding: 'utf8',
      });
      return r.status === 0 ? r.stdout.trim() : null;
    };
    return body({ commit, release, move, remoteTag });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the first release of a major version creates the major tag, here and on the remote', () => {
  withRepo(({ commit, release, move, remoteTag }) => {
    const sha = commit();
    release('v1.0.0');
    const r = move('v1.0.0');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(remoteTag('v1'), sha);
  });
});

test('a newer release moves the major tag, which already exists', () => {
  withRepo(({ commit, release, move, remoteTag }) => {
    commit();
    release('v1.0.0');
    move('v1.0.0');
    const newer = commit();
    release('v1.1.0');
    const r = move('v1.1.0');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(remoteTag('v1'), newer);
  });
});

test('versions are compared as numbers: 1.10.0 is newer than 1.9.0', () => {
  withRepo(({ commit, release, move, remoteTag }) => {
    commit();
    release('v1.9.0');
    move('v1.9.0');
    const newer = commit();
    release('v1.10.0');
    move('v1.10.0');
    assert.equal(remoteTag('v1'), newer);
  });
});

test('a fix for an older line does not pull the major tag backwards', () => {
  withRepo(({ commit, release, move, remoteTag }) => {
    commit();
    release('v1.0.0');
    move('v1.0.0');
    const newest = commit();
    release('v1.1.0');
    move('v1.1.0');
    // a backport: v1.0.1 is published after v1.1.0
    const backport = commit();
    release('v1.0.1');
    const r = move('v1.0.1');
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(backport, newest);
    assert.equal(remoteTag('v1'), newest);
    assert.match(r.stdout, /stays where it is/);
  });
});

test('a new major version gets its own tag and leaves the old one alone', () => {
  withRepo(({ commit, release, move, remoteTag }) => {
    const v1 = commit();
    release('v1.0.0');
    move('v1.0.0');
    const v2 = commit();
    release('v2.0.0');
    const r = move('v2.0.0');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(remoteTag('v1'), v1);
    assert.equal(remoteTag('v2'), v2);
  });
});

test('a pre-release never creates or moves a major tag', () => {
  withRepo(({ commit, release, move, remoteTag }) => {
    const stable = commit();
    release('v1.0.0');
    move('v1.0.0');
    commit();
    release('v1.1.0-beta.1');
    const r = move('v1.1.0-beta.1');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(remoteTag('v1'), stable);
    assert.match(r.stdout, /not a plain release version/);
  });
});

test('something that is not a version is ignored, without an error', () => {
  withRepo(({ commit, release, move, remoteTag }) => {
    commit();
    release('latest');
    const r = move('latest');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(remoteTag('v1'), null);
  });
});

test('without a tag the script fails with a usage message', () => {
  withRepo(({ commit }) => {
    commit();
    const r = spawnSync('bash', [SCRIPT], { env: ENV, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usage/);
  });
});

test('a release tag that is not in the clone is an error, not a silent skip', () => {
  withRepo(({ commit, move }) => {
    commit();
    const r = move('v1.0.0');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not exist in this clone/);
  });
});

test('the workflow runs on published releases, with write access to contents only', () => {
  const file = readFileSync(
    join(import.meta.dirname, '..', '.github', 'workflows', 'major-version-tag.yml'),
    'utf8',
  );
  assert.match(file, /^on:\n {2}release:\n {4}types: \[published\]/m);
  assert.match(file, /^permissions:\n {2}contents: write/m);
  assert.doesNotMatch(file, /(issues|pull-requests|actions|packages): write/);
  assert.match(file, /if: \$\{\{ !github\.event\.release\.prerelease \}\}/);
  // the tag name goes through the environment, never into the script text
  assert.match(file, /TAG: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.doesNotMatch(file, /run:.*\$\{\{/);
});
