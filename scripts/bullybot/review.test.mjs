import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectFindings,
  upsertAcceptanceComment,
  threadLine,
  awaitsReply,
  isThreadsOnlyEvent,
  isSettledByBot,
  threadStatus,
  BOT_RESOLVED,
  MARKER,
  ACCEPTANCE_MARKER,
} from './review.mjs';

const files = new Map([
  ['a.ts', { valid: new Set([1, 2, 3, 10, 20, 30]) }],
  ['b.ts', { valid: new Set([5]) }],
]);
const finding = (path, line, severity) => ({ path, line, severity, comment: `${path}:${line}` });

test('selectFindings drops findings on lines that are not part of the diff', () => {
  const out = selectFindings(
    [
      finding('a.ts', 1, 'minor'),
      finding('a.ts', 4, 'critical'),
      finding('nope.ts', 1, 'critical'),
    ],
    { files, botThreads: [], max: 8 },
  );
  assert.deepEqual(
    out.map((f) => f.comment),
    ['a.ts:1'],
  );
});

test('selectFindings drops repeats within 3 lines of an existing thread on the same file', () => {
  const botThreads = [
    { path: 'a.ts', line: 7 },
    { path: 'b.ts', line: null, originalLine: 5 },
    { path: 'a.ts', line: null, originalLine: null },
  ];
  const out = selectFindings(
    [finding('a.ts', 10, 'minor'), finding('a.ts', 3, 'minor'), finding('b.ts', 5, 'minor')],
    { files, botThreads, max: 8 },
  );
  assert.deepEqual(
    out.map((f) => f.comment),
    ['a.ts:3'],
  );
});

test('selectFindings keeps the most severe findings when hitting the limit', () => {
  const out = selectFindings(
    [
      finding('a.ts', 1, 'minor'),
      finding('a.ts', 2, 'weird'),
      finding('a.ts', 3, 'major'),
      finding('a.ts', 10, 'critical'),
      finding('a.ts', 20, 'major'),
    ],
    { files, botThreads: [], max: 3 },
  );
  assert.deepEqual(
    out.map((f) => f.comment),
    ['a.ts:10', 'a.ts:3', 'a.ts:20'],
  );
});

test('selectFindings handles a missing findings array', () => {
  assert.deepEqual(selectFindings(undefined, { files, botThreads: [], max: 8 }), []);
});

test('threadLine falls back to the original line of outdated threads', () => {
  assert.equal(threadLine({ line: 4, originalLine: 2 }), 4);
  assert.equal(threadLine({ line: null, originalLine: 2 }), 2);
  assert.equal(threadLine({}), null);
});

function fakeGithub() {
  const calls = [];
  return {
    calls,
    rest: {
      issues: {
        createComment: async (args) => calls.push(['create', args]),
        updateComment: async (args) => calls.push(['update', args]),
      },
    },
  };
}
const base = { owner: 'o', repo: 'r', prNumber: 89, report: '### report' };
const BODY = `${MARKER}${ACCEPTANCE_MARKER}\n### report`;

test('upsertAcceptanceComment creates the comment when there is none yet', async () => {
  const github = fakeGithub();
  const result = await upsertAcceptanceComment({
    ...base,
    github,
    comments: [
      { id: 1, body: 'human comment' },
      { id: 2, body: `${MARKER}\nreview` },
    ],
  });
  assert.equal(result, 'created');
  assert.deepEqual(github.calls, [
    ['create', { owner: 'o', repo: 'r', issue_number: 89, body: BODY }],
  ]);
});

test('upsertAcceptanceComment updates the existing checklist comment in place', async () => {
  const github = fakeGithub();
  const result = await upsertAcceptanceComment({
    ...base,
    github,
    comments: [{ id: 7, body: `${MARKER}${ACCEPTANCE_MARKER}\n### old report` }],
  });
  assert.equal(result, 'updated');
  assert.deepEqual(github.calls, [
    ['update', { owner: 'o', repo: 'r', comment_id: 7, body: BODY }],
  ]);
});

test('upsertAcceptanceComment does nothing when the report did not change', async () => {
  const github = fakeGithub();
  const result = await upsertAcceptanceComment({
    ...base,
    github,
    comments: [{ id: 7, body: BODY }],
  });
  assert.equal(result, 'unchanged');
  assert.deepEqual(github.calls, []);
});

const thread = (isResolved, ...bodies) => ({
  isResolved,
  comments: { nodes: bodies.map((body) => ({ body })) },
});

test('awaitsReply is true only for open threads where a human spoke last', () => {
  assert.equal(awaitsReply(thread(false, `${MARKER}\nfinding`, 'that is a false positive')), true);
  assert.equal(awaitsReply(thread(false, `${MARKER}\nfinding`)), false);
  assert.equal(awaitsReply(thread(false, `${MARKER}\nfinding`, 'no', `${MARKER}\nyes`)), false);
  assert.equal(awaitsReply(thread(true, `${MARKER}\nfinding`, 'fixed it')), false);
  assert.equal(awaitsReply(thread(false)), false);
});

test('isThreadsOnlyEvent is true for review comment replies only', () => {
  assert.equal(isThreadsOnlyEvent('pull_request_review_comment'), true);
  assert.equal(isThreadsOnlyEvent('pull_request'), false);
  assert.equal(isThreadsOnlyEvent('workflow_dispatch'), false);
});

test('awaitsReply ignores threads BullyBot already settled, even if a human replies later', () => {
  assert.equal(
    awaitsReply(
      thread(false, `${MARKER}\nfinding`, 'nope', `${MARKER}${BOT_RESOLVED}\nfine`, 'thx'),
    ),
    false,
  );
});

test('isSettledByBot looks for the resolved marker in any reply', () => {
  assert.equal(
    isSettledByBot(thread(false, `${MARKER}\nfinding`, `${MARKER}${BOT_RESOLVED}\nok`)),
    true,
  );
  assert.equal(isSettledByBot(thread(true, `${MARKER}\nfinding`, 'resolved by hand')), false);
});

test('threadStatus distinguishes settled, dismissed and open threads', () => {
  assert.match(
    threadStatus(thread(false, `${MARKER}\nf`, `${MARKER}${BOT_RESOLVED}\nok`)),
    /^settled/,
  );
  assert.match(
    threadStatus(thread(true, `${MARKER}\nf`, `${MARKER}${BOT_RESOLVED}\nok`)),
    /^settled/,
  );
  assert.match(threadStatus(thread(true, `${MARKER}\nf`)), /^DISMISSED/);
  assert.equal(threadStatus(thread(false, `${MARKER}\nf`, 'hmm')), 'open');
});
