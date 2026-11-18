import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampMaxIssues,
  findCandidates,
  hasDescription,
  addSplit,
  mustSplit,
  parseCriteria,
  parseIssueInput,
  refinable,
  refinementReasons,
  renderRefineComment,
  renderRefineDetails,
  renderRefineReport,
  renderSplitComment,
  sanitizeRefinement,
  validateSplit,
} from './refine.mjs';

const GOOD = [
  '## Goal',
  'As a member, I want to vote on meeting times, so that we find a slot together.',
  '',
  '## Acceptance criteria',
  '- [ ] One vote per option',
  '- [ ] Votes can be changed',
  '',
  '## Notes',
  '- not a criterion',
].join('\n');

const issue = (number, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  body: GOOD,
  labels: [],
  milestone: null,
  subIssues: 0,
  openSubIssues: 0,
  ...extra,
});

test('parseIssueInput understands numbers, scan and garbage', () => {
  assert.deepEqual(parseIssueInput('scan'), { scan: true });
  assert.deepEqual(parseIssueInput(''), { scan: true });
  assert.deepEqual(parseIssueInput(' #42 '), { number: 42 });
  assert.deepEqual(parseIssueInput('0'), { invalid: '0' });
  assert.deepEqual(parseIssueInput('delete everything'), { invalid: 'delete everything' });
  assert.equal(clampMaxIssues('x'), 5);
  assert.equal(clampMaxIssues('99'), 20);
});

test('parseCriteria reads the criteria section, or checkboxes when there is no section', () => {
  assert.deepEqual(parseCriteria(GOOD), ['One vote per option', 'Votes can be changed']);
  assert.deepEqual(parseCriteria('Some text\n- [ ] a\n- [x] b\n- plain'), ['a', 'b']);
  assert.deepEqual(parseCriteria('## Acceptance criteria\n- plain item\n\n## Notes\n- other'), [
    'plain item',
  ]);
  assert.deepEqual(parseCriteria(''), []);
  assert.deepEqual(parseCriteria(undefined), []);
});

test('hasDescription ignores headings, checkboxes, markers and the footer', () => {
  assert.equal(hasDescription(GOOD), true);
  assert.equal(hasDescription(''), false);
  assert.equal(
    hasDescription('## Goal\n## Acceptance criteria\n- [ ] one two three four five six seven'),
    false,
  );
  assert.equal(
    hasDescription('<!-- a long hidden comment with many many many words inside it -->'),
    false,
  );
  assert.equal(hasDescription('Users need a way to export their calendar as a file.'), true);
  assert.equal(
    hasDescription('## Goal\nUsers can move between months.\n\n## Acceptance criteria\n- [ ] a'),
    true,
  );
  assert.equal(hasDescription('## Goal\nExport\n'), false);
});

test('refinementReasons names what is missing', () => {
  assert.deepEqual(refinementReasons(issue(1), 'M'), []);
  assert.deepEqual(refinementReasons(issue(1, { body: '' }), null), [
    'no description',
    'no acceptance criteria',
  ]);
  assert.deepEqual(refinementReasons(issue(1), 'XL'), ['size XL']);
  const many = `## Acceptance criteria\n${Array.from({ length: 9 }, (_, i) => `- [ ] item ${i}`).join('\n')}`;
  assert.ok(refinementReasons(issue(1, { body: many }), null).includes('9 criteria'));
});

test('findCandidates skips epics, closed and waiting tickets and puts the clearest cases first', () => {
  const issues = [
    issue(1, { body: '' }),
    issue(2, { labels: ['epic'], body: '' }),
    issue(3, { state: 'closed', body: '' }),
    issue(4, { body: '', labels: ['needs-info'] }),
    issue(5), // fine
    issue(6), // fine but vague
    issue(7, { body: 'Users need a way to export their calendar as a file.' }),
    issue(8, { subIssues: 2, body: '' }),
  ];
  const sizes = new Map([[5, 'XL']]);
  const found = findCandidates({ issues, sizes, vague: [6, 2, 99], max: 10 });
  assert.deepEqual(
    found.map((c) => [c.issue.number, c.reasons]),
    [
      [1, ['no description', 'no acceptance criteria']],
      [5, ['size XL']],
      [7, ['no acceptance criteria']],
      [6, ['vague wording']],
    ],
  );
  assert.equal(findCandidates({ issues, sizes, vague: [6], max: 2 }).length, 2);
  assert.equal(refinable(issues[1]), false);
});

test('a ticket without a description gets a goal and criteria appended', () => {
  const r = sanitizeRefinement(
    {
      assessment: 'refine',
      explanation: 'Filled the gaps.',
      goal: 'As a user I want to export, so that I can share.',
      criteria: ['- [ ] A file is downloaded', 'Errors are shown'],
      size: 'S',
      priority: 'High',
    },
    issue(1, { body: '' }),
  );
  assert.equal(r.action, 'refine');
  assert.equal(
    r.newBody,
    '## Goal\nAs a user I want to export, so that I can share.\n\n## Acceptance criteria\n- [ ] A file is downloaded\n- [ ] Errors are shown',
  );
  assert.deepEqual(r.added, ['added a goal', 'added acceptance criteria']);
  assert.deepEqual([r.size, r.priority], ['S', 'High']);
});

test('human text is kept as it is, only the missing section is appended', () => {
  const human = 'Users need a way to export their calendar as a file.';
  const r = sanitizeRefinement(
    {
      assessment: 'refine',
      explanation: 'x',
      goal: 'ignored, there is text',
      criteria: ['A file is downloaded'],
    },
    issue(1, { body: human }),
  );
  assert.equal(r.newBody, `${human}\n\n## Acceptance criteria\n- [ ] A file is downloaded`);
  assert.deepEqual(r.added, ['added acceptance criteria']);
});

test('a well-formed ticket is not changed, even if the model tries to', () => {
  const r = sanitizeRefinement(
    { assessment: 'refine', explanation: 'x', goal: 'new goal', criteria: ['new'], size: 'M' },
    issue(1),
  );
  assert.equal(r.action, 'none');
  assert.equal(r.newBody, null);
  assert.equal(r.size, null);
  assert.equal(
    sanitizeRefinement({ assessment: 'ok', explanation: 'fine' }, issue(1)).action,
    'none',
  );
});

test('unclear text is rewritten only when the model settles it, and the rewrite must keep checkbox criteria', () => {
  const unclear = 'Make it better somehow.\n- [ ] works well';
  const rewritten =
    '## Goal\nExport the calendar.\n\n## Acceptance criteria\n- [ ] A file is downloaded';
  const r = sanitizeRefinement(
    { assessment: 'refine', explanation: 'Settled by the export code.', rewrittenBody: rewritten },
    issue(1, { body: unclear }),
  );
  assert.equal(r.newBody, rewritten);
  assert.equal(r.rewritten, true);

  const noCriteria = sanitizeRefinement(
    { assessment: 'refine', explanation: 'x', rewrittenBody: '## Goal\nExport the calendar.' },
    issue(1, { body: unclear }),
  );
  assert.equal(noCriteria.rewritten, false);
  assert.match(noCriteria.problems[0], /no acceptance criteria as checkboxes/);

  const completed = sanitizeRefinement(
    {
      assessment: 'refine',
      explanation: 'x',
      rewrittenBody: '## Goal\nExport the calendar for everybody.',
      criteria: ['A file is downloaded'],
    },
    issue(1, { body: unclear }),
  );
  assert.match(completed.newBody, /## Acceptance criteria\n- \[ \] A file is downloaded/);

  const nothingToRewrite = sanitizeRefinement(
    {
      assessment: 'refine',
      explanation: 'x',
      rewrittenBody: 'Whole new text',
      goal: 'G',
      criteria: ['C'],
    },
    issue(1, { body: '' }),
  );
  assert.match(nothingToRewrite.problems[0], /no text to rewrite/);
  assert.equal(nothingToRewrite.rewritten, false);
  assert.match(nothingToRewrite.newBody, /## Goal\nG/);
});

test('questions never change the text and need at least one question', () => {
  const r = sanitizeRefinement(
    {
      assessment: 'needs_info',
      explanation: 'Cannot tell.',
      questions: ['Which calendar?', ' ', '- Per user or per team?'],
      rewrittenBody: 'invented',
      criteria: ['invented'],
      size: 'M',
    },
    issue(1, { body: 'Fix the calendar thing, you know which one.' }),
  );
  assert.equal(r.action, 'ask');
  assert.deepEqual(r.questions, ['Which calendar?', 'Per user or per team?']);
  assert.equal(r.newBody, null);
  assert.equal(r.size, null);
  const empty = sanitizeRefinement(
    { assessment: 'needs_info', explanation: 'x', questions: [] },
    issue(1),
  );
  assert.equal(empty.action, 'none');
  assert.match(empty.problems[0], /without questions/);
});

const SIX = ['a', 'b', 'c', 'd'];
test('a split carries every criterion exactly once, in the original wording', () => {
  const ok = validateSplit(
    {
      reason: 'Two independent behaviors.',
      tickets: [
        {
          title: 'Export',
          story: 'S1',
          covers: [1, 3],
          extraCriteria: ['Fails gracefully'],
          size: 'S',
          priority: 'High',
        },
        { title: 'Import', story: 'S2', covers: [4, 2], size: 'XL', priority: 'nope' },
      ],
    },
    SIX,
  );
  assert.deepEqual(ok.tickets[0].criteria, ['a', 'c', 'Fails gracefully']);
  assert.deepEqual(ok.tickets[1].criteria, ['b', 'd']);
  assert.equal(ok.tickets[1].priority, null);
});

test('a split is refused when a criterion is lost, doubled or invented', () => {
  const t = (title, covers, extra) => ({ title, story: 's', covers, extraCriteria: extra });
  const err = (tickets, criteria = SIX) => validateSplit({ tickets }, criteria).error;
  assert.match(err([t('A', [1, 2]), t('B', [3])]), /criteria 4 are in no sub-ticket/);
  assert.match(err([t('A', [1, 2, 3]), t('B', [3, 4])]), /criterion 3 is in "A" and in "B"/);
  assert.match(err([t('A', [1, 2, 3, 4]), t('B', [5])]), /criterion 5, which does not exist/);
  assert.match(err([t('A', [1, 2, 3, 4]), t('B', [])]), /has no criteria/);
  assert.match(err([t('A', [1, 2, 3, 4])]), /at least two/);
  assert.match(err([t('A', [1, 2]), t('a', [3, 4])]), /same title/);
  assert.match(err([t('', [1, 2]), t('B', [3, 4])]), /no title/);
  assert.match(err([t('A', [1]), t('B', [2])], ['only one']), /fewer than two criteria/);
  assert.match(err(Array.from({ length: 7 }, (_, i) => t(`T${i}`, [i + 1]))), /more than 6/);
});

test('a bad split is discarded without losing the rest of the refinement', () => {
  const r = sanitizeRefinement(
    {
      assessment: 'refine',
      explanation: 'x',
      criteria: ['one', 'two'],
      split: {
        tickets: [
          { title: 'A', story: 's', covers: [1] },
          { title: 'B', story: 's', covers: [1] },
        ],
      },
    },
    issue(1, { body: 'Users need a way to export their calendar as a file.' }),
  );
  assert.equal(r.split, null);
  assert.match(r.problems[0], /split discarded: criterion 1 is in "A" and in "B"/);
  assert.match(r.newBody, /Acceptance criteria/);
});

test('the split is checked against the criteria after the refinement', () => {
  const r = sanitizeRefinement(
    {
      assessment: 'refine',
      explanation: 'x',
      criteria: ['one', 'two'],
      split: {
        reason: 'r',
        tickets: [
          { title: 'A', story: 's', covers: [1] },
          { title: 'B', story: 's', covers: [2] },
        ],
      },
    },
    issue(1, { body: 'Users need a way to export their calendar as a file.' }),
  );
  assert.equal(r.split.tickets.length, 2);
  assert.equal(r.action, 'refine');
});

test('the comment keeps the original text safely fenced when a rewrite happened', () => {
  const original = 'Old text with ``` a fence\n- [ ] x';
  const comment = renderRefineComment({
    issue: issue(1),
    result: {
      action: 'refine',
      explanation: 'Settled.',
      added: ['rewrote the unclear text'],
      rewritten: true,
      questions: [],
    },
    original,
  });
  assert.match(comment, /^<!-- product-owner:refine -->/);
  assert.match(comment, /<details><summary>Original text<\/summary>/);
  assert.match(comment, /````markdown\nOld text with ``` a fence/);

  const ask = renderRefineComment({
    issue: issue(1),
    result: { action: 'ask', explanation: 'Unclear.', added: [], questions: ['Which one?'] },
  });
  assert.match(ask, /- Which one\?/);
  assert.match(ask, /needs-info/);
});

test('split comments differ between a proposal and created sub-issues', () => {
  const result = {
    split: {
      reason: 'Too big.',
      tickets: [{ title: 'A', story: 'S', criteria: ['a'], size: 'S', priority: 'High' }],
    },
  };
  const proposal = renderSplitComment({ result });
  assert.match(proposal, /Nothing was created/);
  assert.match(proposal, /\*\*A\*\*/);
  const done = renderSplitComment({ result, createdTickets: [{ number: 12 }] });
  assert.match(done, /\*\*#12 A\*\*/);
  assert.match(done, /exactly one/);
});

test('the report lists every ticket, what was discarded and the problems', () => {
  const outcomes = [
    {
      issue: issue(1, { title: 'A | B' }),
      reasons: ['no description'],
      result: {
        action: 'refine',
        added: ['added a goal'],
        questions: [],
        problems: ['split discarded: x'],
        split: null,
        explanation: 'e',
        newBody: 'text',
      },
      size: 'M',
      priority: 'High',
      status: 'done',
    },
    {
      issue: issue(2),
      reasons: ['vague wording'],
      result: {
        action: 'ask',
        added: [],
        questions: ['Q?'],
        problems: [],
        split: null,
        explanation: 'u',
      },
      status: 'proposed',
    },
  ];
  const report = renderRefineReport({
    outcomes,
    dryRun: true,
    apply: false,
    problems: ['board down'],
  });
  assert.match(report, /dry run, nothing was changed/);
  assert.match(
    report,
    /\| #1 A \\\| B \| no description \| added a goal, size M, priority High \| done \|/,
  );
  assert.match(report, /1 question\(s\), label needs-info/);
  assert.match(report, /#1: split discarded: x/);
  assert.match(report, /board down/);
  assert.match(renderRefineDetails(outcomes), /New text:\n\ntext/);
  assert.match(renderRefineReport({ outcomes: [], dryRun: false }), /Nothing to refine/);
});

test('a rewrite is discarded when the ticket was not picked for unclear wording', () => {
  const raw = {
    assessment: 'refine',
    explanation: 'x',
    rewrittenBody: '## Goal\nSomething else entirely.\n\n## Acceptance criteria\n- [ ] A\n- [ ] B',
  };
  const scanned = sanitizeRefinement(raw, issue(1), { allowRewrite: false });
  assert.equal(scanned.newBody, null);
  assert.equal(scanned.action, 'none');
  assert.match(scanned.problems[0], /not picked for unclear wording/);
  assert.equal(sanitizeRefinement(raw, issue(1)).rewritten, true);
});

test('an announced refinement without content is reported, not hidden', () => {
  const r = sanitizeRefinement(
    { assessment: 'refine', explanation: 'I split this ticket into three.', size: 'L' },
    issue(1),
  );
  assert.equal(r.action, 'none');
  assert.deepEqual(r.problems, ['the model announced a refinement but delivered nothing usable']);
  const ok = sanitizeRefinement({ assessment: 'ok', explanation: 'Fine.' }, issue(1));
  assert.deepEqual(ok.problems, []);
});

test('mustSplit follows the objective rules', () => {
  assert.equal(mustSplit(issue(1), 'M'), false);
  assert.equal(mustSplit(issue(1), 'XL'), true);
  assert.equal(
    mustSplit(issue(1, { body: '## Acceptance criteria\n- [ ] only one' }), 'XL'),
    false,
  );
  const many = `## Acceptance criteria\n${Array.from({ length: 9 }, (_, i) => `- [ ] item ${i}`).join('\n')}`;
  assert.equal(mustSplit(issue(1, { body: many }), 'M'), true);
});

test('a split requested afterwards is checked like the first one', () => {
  const announced = sanitizeRefinement(
    { assessment: 'refine', explanation: 'I split it.', size: 'L' },
    issue(1),
  );
  assert.equal(announced.action, 'none');
  const good = {
    reason: 'Two behaviors.',
    tickets: [
      { title: 'A', story: 's', covers: [1, 2], size: 'S', priority: 'High' },
      { title: 'B', story: 's', covers: [3, 4], size: 'S', priority: 'High' },
    ],
  };
  const body = `## Acceptance criteria\n${['a', 'b', 'c', 'd'].map((c) => `- [ ] ${c}`).join('\n')}`;
  const withSplit = addSplit(announced, good, issue(1, { body }), { size: 'L', priority: 'High' });
  assert.equal(withSplit.action, 'refine');
  assert.equal(withSplit.split.tickets.length, 2);
  assert.deepEqual(withSplit.problems, []);
  assert.deepEqual([withSplit.size, withSplit.priority], ['L', 'High']);

  const bad = addSplit(
    announced,
    { tickets: [good.tickets[0], good.tickets[0]] },
    issue(1, { body }),
    {},
  );
  assert.equal(bad.action, 'none');
  assert.match(bad.problems[0], /split discarded/);
});
