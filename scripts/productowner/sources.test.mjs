import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSourceDirs, parseSourceDirs, selectSourceFiles } from './sources.mjs';

test('parseSourceDirs: comma and line separated, cleaned up', () => {
  assert.deepEqual(parseSourceDirs('src, ./libs/ui/ \n apps/web/src'), [
    'src',
    'libs/ui',
    'apps/web/src',
  ]);
});

test('parseSourceDirs: ignores empty, absolute and escaping entries', () => {
  assert.deepEqual(parseSourceDirs(',, /etc, ../secret, a/../b, ok'), ['ok']);
  assert.deepEqual(parseSourceDirs(undefined), []);
  assert.deepEqual(parseSourceDirs(''), []);
});

test('detectSourceDirs: single project', () => {
  assert.deepEqual(detectSourceDirs(['README.md', 'src/app.ts', 'src/app.css']), ['src']);
});

test('detectSourceDirs: Angular workspace', () => {
  assert.deepEqual(detectSourceDirs(['angular.json', 'projects/app/src/main.ts']), ['projects']);
});

test('detectSourceDirs: monorepo', () => {
  assert.deepEqual(detectSourceDirs(['packages/a/index.js', 'packages/b/index.html']), [
    'packages',
  ]);
});

test('detectSourceDirs: takes all the default directories that exist', () => {
  assert.deepEqual(detectSourceDirs(['src/a.ts', 'packages/b/b.ts', 'projects/c/c.ts']), [
    'src',
    'projects',
    'packages',
  ]);
});

test('detectSourceDirs: a directory without source files does not count', () => {
  assert.deepEqual(detectSourceDirs(['src/notes.md', 'packages/b/b.ts']), ['packages']);
});

test('detectSourceDirs: nothing found means the whole repository', () => {
  assert.equal(detectSourceDirs(['index.js', 'lib/a.js']), null);
});

test('detectSourceDirs: the configuration replaces the detection', () => {
  assert.deepEqual(detectSourceDirs(['src/a.ts'], ['apps/web']), ['apps/web']);
});

test('selectSourceFiles: only whole directories, source files, no tests or noise', () => {
  const tree = [
    'src/app.ts',
    'src/app.spec.ts',
    'src/view.html',
    'src/readme.md',
    'src-old/app.ts',
    'srcx/app.ts',
    'lib/other.ts',
    'src/dist/bundle.js',
    'src/app.min.js',
    'package-lock.json',
  ];
  assert.deepEqual(selectSourceFiles(tree, ['src']), ['src/app.ts', 'src/view.html']);
});

test('selectSourceFiles: without directories the whole repository counts', () => {
  assert.deepEqual(selectSourceFiles(['lib/a.js', 'b.ts', 'c.md', 'x.test.js'], null), [
    'lib/a.js',
    'b.ts',
  ]);
});
