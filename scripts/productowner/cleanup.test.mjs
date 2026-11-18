import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampMaxIssues,
  clampStaleDays,
  describeAction,
  eligibleIssues,
  formatCleanupBacklog,
  idleDays,
  renderCleanupReport,
  renderComment,
  sanitizeVerdicts,
} from './cleanup.mjs';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

const issue = (number, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  body: '',
  labels: [],
  milestone: null,
  updatedAt: daysAgo(1),
  openSubIssues: 0,
  subIssues: 0,
  ...extra,
});

test('clamps the inputs and falls back to the defaults', () => {
  assert.equal(clampStaleDays(undefined), 90);
  assert.equal(clampStaleDays('30'), 30);
  assert.equal(clampStaleDays('-5'), 90);
  assert.equal(clampMaxIssues('abc'), 10);
  assert.equal(clampMaxIssues('999'), 50);
});

test('idleDays counts whole days and never guesses "fresh" for a missing date', () => {
  assert.equal(idleDays(issue(1, { updatedAt: daysAgo(95) }), NOW), 95);
  assert.equal(idleDays(issue(1, { updatedAt: null }), NOW), Infinity);
});

test('eligibleIssues skips closed issues and epics that are in progress or unknown', () => {
  const list = [
    issue(1),
    issue(2, { state: 'closed' }),
    issue(3, { labels: ['epic'], subIssues: 3, openSubIssues: 1 }),
    issue(4, { labels: ['epic'], subIssues: 0 }),
    issue(5, { labels: ['epic'], subIssues: 2, openSubIssues: 0 }),
    issue(6, { subIssues: 2, openSubIssues: 2 }),
  ];
  assert.deepEqual(
    eligibleIssues(list).map((i) => i.number),
    [1, 5],
  );
});

const setup = (list) => ({
  issues: list,
  eligible: eligibleIssues(list),
  staleDays: 90,
  now: NOW,
  max: 10,
});

test('sanitizeVerdicts accepts valid verdicts and derives the action', () => {
  const ctx = setup([
    issue(1, { updatedAt: daysAgo(200) }),
    issue(2),
    issue(3),
    issue(4, { updatedAt: daysAgo(100) }),
    issue(9, { state: 'closed' }),
  ]);
  const { proposals, dropped } = sanitizeVerdicts(
    {
      verdicts: [
        { number: 1, kind: 'inactive', closeIssue: true, reason: 'Nobody asked for it.' },
        { number: 2, kind: 'implemented', reason: 'Done in app.ts.', target: 9 },
        { number: 3, kind: 'duplicate', target: 9, reason: 'Same as #9.' },
        { number: 4, kind: 'superseded', target: 7, reason: 'x' },
      ],
    },
    ctx,
  );
  assert.deepEqual(
    proposals.map((p) => [p.number, p.action, p.target]),
    [
      [2, 'close_completed', null],
      [3, 'duplicate', 9],
      [1, 'close_not_planned', null],
    ],
  );
  assert.match(
    dropped[0].reason,
    /#4: superseded of #7, which does not exist|#4: superseded of #7/,
  );
});

test('sanitizeVerdicts discards verdicts it cannot trust', () => {
  const ctx = setup([
    issue(1, { updatedAt: daysAgo(10) }),
    issue(2, { labels: ['epic'], subIssues: 2, openSubIssues: 1 }),
    issue(3, { updatedAt: daysAgo(200), labels: ['stale'] }),
    issue(4),
    issue(5),
    issue(8, { state: 'closed' }),
  ]);
  const { proposals, dropped } = sanitizeVerdicts(
    {
      verdicts: [
        { number: 1, kind: 'inactive', reason: 'old' }, // only 10 days idle
        { number: 2, kind: 'implemented', reason: 'epic' }, // epic in progress
        { number: 3, kind: 'inactive', reason: 'old' }, // already flagged, would only be flagged again
        { number: 4, kind: 'duplicate', target: 99, reason: 'dupe' }, // target does not exist
        { number: 5, kind: 'superseded', target: 3, reason: 'older target' }, // not newer
        { number: 5, kind: 'implemented', reason: '  ' }, // no reason
        { number: 6, kind: 'implemented', reason: 'not in the backlog' },
        { number: 8, kind: 'implemented', reason: 'closed' },
        { number: 5, kind: 'wrong', reason: 'x' },
        null,
      ],
    },
    ctx,
  );
  assert.deepEqual(proposals, []);
  assert.equal(dropped.length, 10);
  assert.match(dropped[0].reason, /not inactive, last activity 10 days ago/);
  assert.match(dropped[2].reason, /already labeled stale/);
  assert.match(dropped[3].reason, /#99, which does not exist/);
});

test('sanitizeVerdicts keeps only the first verdict of an issue', () => {
  const { proposals, dropped } = sanitizeVerdicts(
    {
      verdicts: [
        { number: 1, kind: 'implemented', reason: 'first' },
        { number: 1, kind: 'duplicate', target: 2, reason: 'second' },
      ],
    },
    setup([issue(1), issue(2)]),
  );
  assert.deepEqual(
    proposals.map((p) => p.reason),
    ['first'],
  );
  assert.match(dropped[0].reason, /named twice/);
});

test('sanitizeVerdicts caps the proposals and defers the rest, closing before flagging', () => {
  const list = [1, 2, 3, 4].map((n) => issue(n, { updatedAt: daysAgo(200) }));
  const { proposals, deferred } = sanitizeVerdicts(
    {
      verdicts: [
        { number: 1, kind: 'inactive', closeIssue: false, reason: 'quiet' },
        { number: 2, kind: 'inactive', closeIssue: true, reason: 'obsolete' },
        { number: 3, kind: 'implemented', reason: 'done' },
        { number: 4, kind: 'inactive', closeIssue: false, reason: 'quiet' },
      ],
    },
    { ...setup(list), max: 2 },
  );
  assert.deepEqual(
    proposals.map((p) => p.number),
    [3, 2],
  );
  assert.deepEqual(
    deferred.map((p) => p.number),
    [1, 4],
  );
});

test('sanitizeVerdicts survives a malformed answer', () => {
  const ctx = setup([issue(1)]);
  assert.deepEqual(sanitizeVerdicts(undefined, ctx).proposals, []);
  assert.deepEqual(sanitizeVerdicts({ verdicts: 'x' }, ctx).proposals, []);
});

test('the comment explains the reason and what was done', () => {
  const base = { number: 1, title: 'T', reason: 'Because.', idle: 100 };
  const closed = renderComment({ ...base, kind: 'duplicate', action: 'duplicate', target: 9 });
  assert.match(closed, /^<!-- product-owner:cleanup -->/);
  assert.match(closed, /Because\./);
  assert.match(closed, /duplicate of #9/);
  assert.match(
    renderComment({ ...base, kind: 'superseded', action: 'close_not_planned', target: 9 }),
    /superseded by #9/,
  );
  assert.match(
    renderComment({ ...base, kind: 'implemented', action: 'close_completed' }),
    /as completed/,
  );
  assert.match(
    renderComment({ ...base, kind: 'inactive', action: 'flag' }),
    /labeled this issue `stale`/,
  );
  assert.equal(describeAction({ action: 'duplicate', target: 9 }), 'close as duplicate of #9');
});

test('the report lists every proposal, the discarded ones and the problems', () => {
  const proposals = [
    { number: 1, title: 'A | B', kind: 'implemented', action: 'close_completed', reason: 'Done.' },
    { number: 2, title: 'C', kind: 'inactive', action: 'flag', reason: 'Quiet.' },
  ];
  const dry = renderCleanupReport({
    proposals,
    dropped: [{ reason: '#3: no reason given' }],
    deferred: [{ number: 4, action: 'flag' }],
    dryRun: true,
    staleDays: 90,
  });
  assert.match(dry, /dry run, nothing was changed/);
  assert.match(dry, /\| #1 A \\\| B \| implemented \| close as completed \| Done\. \| proposed \|/);
  assert.match(dry, /#4 \(label "stale"\)/);
  assert.match(dry, /#3: no reason given/);

  const real = renderCleanupReport({
    proposals,
    dropped: [],
    deferred: [],
    applied: new Set([1]),
    problems: ['#2 could not be cleaned up: nope'],
    dryRun: false,
    staleDays: 90,
  });
  assert.match(real, /\| done \|/);
  assert.match(real, /\| failed \|/);
  assert.match(real, /#2 could not be cleaned up: nope/);
  assert.match(
    renderCleanupReport({ proposals: [], dropped: [], deferred: [], dryRun: true, staleDays: 90 }),
    /Nothing to clean up/,
  );
});

test('the backlog text shows how long each open issue has been idle', () => {
  const { open, closed } = formatCleanupBacklog(
    [issue(1, { updatedAt: daysAgo(120), body: 'some\n text' }), issue(2, { state: 'closed' })],
    NOW,
  );
  assert.match(open, /#1 Issue 1 \[idle 120 days\]\n  some text/);
  assert.equal(closed, '#2 Issue 2');
});
