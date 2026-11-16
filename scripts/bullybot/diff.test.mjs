import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, isNoise, isTestFile, findRelatedTests } from './diff.mjs';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1 @@
+export const b = 1;
\\ No newline at end of file`;

test('parseDiff annotates new-file line numbers and records commentable lines', () => {
  const files = parseDiff(DIFF);
  assert.deepEqual([...files.keys()], ['src/a.ts', 'src/b.ts']);

  const a = files.get('src/a.ts');
  assert.deepEqual([...a.valid], [1, 2, 3, 4]);
  assert.ok(a.annotated.includes('L2| +const b = 3;'));
  assert.ok(a.annotated.includes('     | -const b = 2;'));

  const b = files.get('src/b.ts');
  assert.deepEqual([...b.valid], [1]);
  assert.ok(b.annotated.includes('\\ No newline at end of file'));
});

test('parseDiff returns an empty map for an empty diff', () => {
  assert.equal(parseDiff('').size, 0);
});

test('isNoise flags lockfiles, binaries and build output only', () => {
  for (const p of [
    'package-lock.json',
    'scripts/package-lock.json',
    'public/favicon.ico',
    'dist/app.js',
    'x.min.js',
  ]) {
    assert.ok(isNoise(p), p);
  }
  for (const p of ['package.json', 'src/app.ts', 'src/distance.ts', 'README.md']) {
    assert.ok(!isNoise(p), p);
  }
});

test('isTestFile recognizes spec, test and e2e files', () => {
  assert.ok(isTestFile('src/app/calendar.spec.ts'));
  assert.ok(isTestFile('scripts/bullybot/diff.test.mjs'));
  assert.ok(isTestFile('e2e/login.ts'));
  assert.ok(!isTestFile('src/app/calendar.ts'));
  assert.ok(!isTestFile('src/app/spec-helper.ts'));
});

test('findRelatedTests finds unchanged sibling tests of changed sources', () => {
  const tree = [
    'src/calendar.ts',
    'src/calendar.spec.ts',
    'src/util.mjs',
    'src/util.test.mjs',
    'src/nav.ts',
    'src/nav.spec.ts',
    'src/lonely.ts',
  ];
  assert.deepEqual(
    findRelatedTests(
      [
        'src/calendar.ts',
        'src/util.mjs',
        'src/nav.ts',
        'src/nav.spec.ts',
        'src/lonely.ts',
        'README.md',
      ],
      tree,
    ),
    ['src/calendar.spec.ts', 'src/util.test.mjs'],
  );
});
