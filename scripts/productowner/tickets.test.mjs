import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle,
  resolveMilestone,
  sanitizePlan,
  renderTicketBody,
  renderEpicBody,
  PO_MARKER,
} from './tickets.mjs';
import { parseAcceptanceCriteria } from '../bullybot/acceptance.mjs';

const milestones = [
  { number: 1, title: 'M1: MVP – find a time together' },
  { number: 2, title: 'M2: Teams & meetings' },
];
const issues = [
  { number: 81, title: 'Epic: Quality, operations & legal', state: 'open', labels: ['epic'] },
  { number: 90, title: 'Epic: Old stuff', state: 'closed', labels: ['epic'] },
  { number: 87, title: 'Onboarding and help pages', state: 'open', labels: ['frontend'] },
];
const env = { labels: ['frontend', 'backend', 'epic', 'qa'], milestones, issues, max: 6 };

const ticket = (over = {}) => ({
  title: 'Vote on meeting times',
  story: 'As a team member, I want to vote, so that we find a slot.',
  criteria: ['A member can vote once per option'],
  labels: ['frontend'],
  milestone: 'M2',
  size: 'M',
  priority: 'High',
  ...over,
});

test('normalizeTitle ignores case, punctuation and the epic prefix', () => {
  assert.equal(normalizeTitle('Epic: Onboarding & Help!'), normalizeTitle('onboarding and help'));
});

test('resolveMilestone matches full title, short prefix and rejects unknown names', () => {
  assert.equal(resolveMilestone('M2', milestones).number, 2);
  assert.equal(resolveMilestone('m1: mvp – find a time together', milestones).number, 1);
  assert.equal(resolveMilestone('M9', milestones), null);
  assert.equal(resolveMilestone('', milestones), null);
});

test('sanitizePlan keeps valid tickets and resolves labels, milestone and size', () => {
  const plan = sanitizePlan(
    { summary: ' hi ', tickets: [ticket({ labels: ['Frontend', 'nope', 'epic'] })] },
    env,
  );
  assert.equal(plan.summary, 'hi');
  assert.equal(plan.tickets.length, 1);
  assert.deepEqual(plan.tickets[0].labels, ['frontend']);
  assert.equal(plan.tickets[0].milestone.number, 2);
  assert.equal(plan.tickets[0].size, 'M');
});

test('sanitizePlan drops invalid sizes and priorities instead of guessing', () => {
  const [t] = sanitizePlan({ tickets: [ticket({ size: 'HUGE', priority: 'P9' })] }, env).tickets;
  assert.equal(t.size, null);
  assert.equal(t.priority, null);
});

test('sanitizePlan rejects duplicates of existing issues and of earlier drafts', () => {
  const plan = sanitizePlan(
    { tickets: [ticket({ title: 'Onboarding & help pages' }), ticket(), ticket()] },
    env,
  );
  assert.equal(plan.tickets.length, 1);
  assert.deepEqual(
    plan.dropped.map((d) => d.reason),
    ['already exists as #87', 'duplicate in this run'],
  );
});

test('sanitizePlan rejects tickets without acceptance criteria or title', () => {
  const plan = sanitizePlan(
    { tickets: [ticket({ criteria: ['  ', '- [ ] '] }), ticket({ title: '  ' })] },
    env,
  );
  assert.equal(plan.tickets.length, 0);
  assert.deepEqual(
    plan.dropped.map((d) => d.reason),
    ['no acceptance criteria', 'no title'],
  );
});

test('sanitizePlan strips checkbox prefixes from criteria and caps their number', () => {
  const criteria = ['- [ ] first', ...Array.from({ length: 20 }, (_, i) => `c${i}`)];
  const [t] = sanitizePlan({ tickets: [ticket({ criteria })] }, env).tickets;
  assert.equal(t.criteria[0], 'first');
  assert.equal(t.criteria.length, 12);
});

test('sanitizePlan enforces the ticket limit', () => {
  const tickets = ['a', 'b', 'c'].map((title) => ticket({ title }));
  const plan = sanitizePlan({ tickets }, { ...env, max: 2 });
  assert.equal(plan.tickets.length, 2);
  assert.match(plan.dropped[0].reason, /limit of 2/);
});

test('sanitizePlan only keeps related issues that exist', () => {
  const [t] = sanitizePlan({ tickets: [ticket({ relatedIssues: [87, 87, 4711] })] }, env).tickets;
  assert.deepEqual(t.related, [87]);
});

test('epic: an existing open epic is used, closed or invented ones are not', () => {
  const t = [ticket()];
  assert.deepEqual(sanitizePlan({ tickets: t, epicNumber: 81 }, env).epic, {
    existing: 81,
    title: 'Epic: Quality, operations & legal',
  });
  assert.equal(sanitizePlan({ tickets: t, epicNumber: 90 }, env).epic, null);
  assert.equal(sanitizePlan({ tickets: t, epicNumber: 4711 }, env).epic, null);
  assert.equal(sanitizePlan({ tickets: t, epicNumber: 87 }, env).epic, null); // not an epic
});

test('epic: a new epic gets the "Epic:" prefix and needs tickets', () => {
  const epic = sanitizePlan(
    { tickets: [ticket()], newEpicTitle: 'Voting', newEpicGoal: 'g' },
    env,
  ).epic;
  assert.deepEqual(epic, { existing: null, title: 'Epic: Voting', goal: 'g' });
  assert.equal(sanitizePlan({ tickets: [], newEpicTitle: 'Voting' }, env).epic, null);
});

test('renderTicketBody uses the layout the repo and BullyBot expect', () => {
  const [t] = sanitizePlan(
    {
      tickets: [
        ticket({ outOfScope: ['Ranking'], notes: 'Use the poll API', relatedIssues: [87] }),
      ],
    },
    env,
  ).tickets;
  const body = renderTicketBody(t);
  assert.match(body, /^## Goal\nAs a team member/);
  assert.match(body, /## Out of scope\n- Ranking/);
  assert.match(body, /## Notes\nUse the poll API\n\nRelated: #87/);
  assert.ok(body.includes(PO_MARKER));
  // BullyBot must be able to read the criteria back
  assert.deepEqual(parseAcceptanceCriteria(body), [
    { text: 'A member can vote once per option', checked: false },
  ]);
});

test('renderTicketBody leaves out empty optional sections', () => {
  const [t] = sanitizePlan({ tickets: [ticket()] }, env).tickets;
  assert.doesNotMatch(renderTicketBody(t), /Out of scope|## Notes/);
});

test('renderEpicBody lists the sub-tickets', () => {
  const body = renderEpicBody({ title: 'Epic: Voting', goal: 'Decide together' }, [
    { title: 'A' },
    { title: 'B' },
  ]);
  assert.match(body, /## Goal\nDecide together/);
  assert.match(body, /sub-issues of this epic:\n- A\n- B/);
});
