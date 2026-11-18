import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchBacklog,
  fetchLabels,
  fetchMilestones,
  formatBacklog,
  formatMilestones,
} from './backlog.mjs';

test('fetchBacklog drops pull requests and flattens labels and milestones', async () => {
  const listForRepo = async () => {};
  const github = {
    rest: { issues: { listForRepo } },
    paginate: async (fn, opts) => {
      assert.equal(fn, listForRepo);
      assert.equal(opts.state, 'all');
      return [
        {
          number: 1,
          title: 'A',
          state: 'open',
          body: null,
          labels: [{ name: 'epic' }, 'qa'],
          milestone: { title: 'M1' },
        },
        { number: 2, title: 'PR', state: 'open', labels: [], pull_request: {} },
      ];
    },
  };
  assert.deepEqual(await fetchBacklog({ github, owner: 'o', repo: 'r' }), [
    {
      number: 1,
      title: 'A',
      state: 'open',
      body: '',
      labels: ['epic', 'qa'],
      milestone: 'M1',
      updatedAt: null,
      openSubIssues: 0,
      subIssues: 0,
    },
  ]);
});

test('formatBacklog previews open issues and lists closed ones as titles only', () => {
  const { open, closed } = formatBacklog([
    {
      number: 1,
      title: 'Open one',
      state: 'open',
      body: 'line one\n\nline   two',
      labels: ['qa'],
      milestone: 'M1',
    },
    { number: 2, title: 'Open empty', state: 'open', body: '', labels: [], milestone: null },
    {
      number: 3,
      title: 'Done',
      state: 'closed',
      body: 'secret details',
      labels: [],
      milestone: null,
    },
  ]);
  assert.equal(
    open,
    '#1 Open one [qa, M1]\n  line one line two\n#2 Open empty\n  (no description)',
  );
  assert.equal(closed, '#3 Done');
});

test('formatMilestones shows descriptions when present', () => {
  assert.equal(
    formatMilestones([
      { title: 'M1', description: 'MVP' },
      { title: 'M2', description: '' },
    ]),
    '- M1: MVP\n- M2',
  );
});

test('fetchLabels uses the repository label method and returns names', async () => {
  const listLabelsForRepo = async () => {};
  const github = {
    rest: { issues: { listLabelsForRepo } },
    paginate: async (fn) => {
      assert.equal(fn, listLabelsForRepo);
      return [{ name: 'bug' }, { name: 'epic' }];
    },
  };
  assert.deepEqual(await fetchLabels({ github, owner: 'o', repo: 'r' }), ['bug', 'epic']);
});

test('loading fails loudly when the client lacks the method, instead of paginating the API root', async () => {
  // like real Octokit: paginate(undefined) would not throw, it requests "/" and returns one object
  const github = { rest: { issues: {} }, paginate: async () => [{ current_user_url: 'x' }] };
  await assert.rejects(
    fetchLabels({ github, owner: 'o', repo: 'r' }),
    /no issues\.listLabelsForRepo/,
  );
  await assert.rejects(
    fetchMilestones({ github, owner: 'o', repo: 'r' }),
    /no issues\.listMilestones/,
  );
  await assert.rejects(fetchBacklog({ github, owner: 'o', repo: 'r' }), /no issues\.listForRepo/);
});
