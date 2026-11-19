import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyToCheckout } from './applyfix.mjs';

const proposal = (extra = {}) => ({
  v: 1,
  threadId: 'T1',
  path: 'src/a.mjs',
  startLine: 2,
  endLine: 2,
  original: ['two'],
  replacement: ['TWO'],
  explanation: 'Shouted.',
  baseSha: 'a'.repeat(40),
  headRef: 'feat/x',
  prNumber: 7,
  requestedBy: 'lea',
  ...extra,
});

/** A checkout in a temporary folder, removed afterwards. */
function withCheckout(body) {
  const dir = mkdtempSync(join(tmpdir(), 'apply-fix-'));
  try {
    const root = join(dir, 'checkout');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.mjs'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'outside.txt'), 'one\ntwo\nthree\n');
    return body({ root, dir, read: (p) => readFileSync(join(root, p), 'utf8') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the fix is written into the file of the checkout', () => {
  withCheckout(({ root, read }) => {
    assert.deepEqual(applyToCheckout({ proposal: proposal(), root, maxLines: 5 }), { ok: true });
    assert.equal(read('src/a.mjs'), 'one\nTWO\nthree\n');
  });
});

test('a proposal that is not valid is not applied', () => {
  withCheckout(({ root, read }) => {
    for (const extra of [
      { path: '.github/workflows/ci.yml' },
      { path: '../outside.txt' },
      { v: 3 },
    ]) {
      const result = applyToCheckout({ proposal: proposal(extra), root, maxLines: 5 });
      assert.equal(result.ok, false);
      assert.match(result.reason, /not valid/);
    }
    assert.equal(read('src/a.mjs'), 'one\ntwo\nthree\n');
  });
});

test('a changed file, a missing file and a folder are not touched', () => {
  withCheckout(({ root, read }) => {
    writeFileSync(join(root, 'src', 'a.mjs'), 'one\nCHANGED\nthree\n');
    assert.match(applyToCheckout({ proposal: proposal(), root, maxLines: 5 }).reason, /changed/);
    assert.match(
      applyToCheckout({ proposal: proposal({ path: 'src/none.mjs' }), root, maxLines: 5 }).reason,
      /does not exist/,
    );
    assert.match(
      applyToCheckout({ proposal: proposal({ path: 'src' }), root, maxLines: 5 }).reason,
      /not a regular file/,
    );
    assert.equal(read('src/a.mjs'), 'one\nCHANGED\nthree\n');
  });
});

test('links cannot lead the fix out of the checkout', () => {
  withCheckout(({ root, dir, read }) => {
    // the file itself is a link to a file outside
    symlinkSync(join(dir, 'outside.txt'), join(root, 'src', 'link.mjs'));
    assert.match(
      applyToCheckout({ proposal: proposal({ path: 'src/link.mjs' }), root, maxLines: 5 }).reason,
      /not a regular file/,
    );
    // a folder of the checkout is a link to a folder outside
    symlinkSync(dir, join(root, 'linked'));
    assert.match(
      applyToCheckout({ proposal: proposal({ path: 'linked/outside.txt' }), root, maxLines: 5 })
        .reason,
      /through a link/,
    );
    assert.equal(readFileSync(join(dir, 'outside.txt'), 'utf8'), 'one\ntwo\nthree\n');
    assert.equal(read('src/a.mjs'), 'one\ntwo\nthree\n');
  });
});

test('the command line entry applies the proposal from the environment and fails with a message otherwise', () => {
  withCheckout(({ root, read }) => {
    const script = join(import.meta.dirname, '..', 'bullybot-apply.mjs');
    const run = (env) =>
      spawnSync('node', [script], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
    const ok = run({ PROPOSAL: JSON.stringify(proposal()) });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(read('src/a.mjs'), 'one\nTWO\nthree\n');

    const stale = run({ PROPOSAL: JSON.stringify(proposal()) }); // the original lines are gone now
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /::error::The fix was not applied: the lines have changed/);

    const garbage = run({ PROPOSAL: 'not json' });
    assert.equal(garbage.status, 1);
    assert.match(garbage.stderr, /no usable fix proposal/);
  });
});
